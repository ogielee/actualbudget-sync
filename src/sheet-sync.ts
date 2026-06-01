/**
 * sheet-sync: Weekly Google Sheets → Actual Budget sync
 *
 * Reads the "Budget 2026 v2" tab from Google Sheets, sums all weeks in the
 * current month up to today, and sets those as the monthly budget amounts in
 * Actual Budget.  The operation is idempotent — running it multiple times or
 * editing a past week in the sheet and re-running will produce the same correct
 * result.
 */

import * as api from "@actual-app/api"
import { google } from "googleapis"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// ── Config ────────────────────────────────────────────────────────────────────

function loadEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=")
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )
}

const ENV_PATH =
  process.env.ENV_FILE ??
  join(process.env.USERPROFILE ?? "~", "akahu-sync", ".env")
const env = { ...loadEnv(ENV_PATH), ...process.env }

const SHEET_ID = env.GOOGLE_SHEETS_ID
const TAB_NAME = "Budget 2026 v2"
const ACTUAL_SERVER = env.ACTUAL_SERVER
const ACTUAL_PASSWORD = env.ACTUAL_PASSWORD
const ACTUAL_SYNC_ID = env.ACTUAL_SYNC_ID
const ACTUAL_DATA =
  env.ACTUAL_DATA ?? join(process.env.USERPROFILE ?? "~", "akahu-sync", "data")
const DRY_RUN = process.argv.includes("--dry-run")

for (const [k, v] of Object.entries({
  SHEET_ID,
  ACTUAL_SERVER,
  ACTUAL_PASSWORD,
  ACTUAL_SYNC_ID,
})) {
  if (!v) {
    console.error(`Missing required env var: ${k}`)
    process.exit(1)
  }
}

// ── Google Sheets auth ────────────────────────────────────────────────────────

function sheetsClient() {
  const auth = new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
  )
  auth.setCredentials({ refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN })
  return google.sheets({ version: "v4", auth })
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Return YYYY-MM for a date. */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

/** Parse a header cell value into a Date if it looks like an ISO date (YYYY-MM-DD). */
function parseISODate(v: string | null | undefined): Date | null {
  if (!v) return null
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return new Date(v)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const currentMonth = monthKey(today)

  console.log(`\n=== Sheet Budget Sync ===`)
  console.log(`Date:  ${toISO(today)}`)
  console.log(`Month: ${currentMonth}`)
  if (DRY_RUN) console.log("Mode:  DRY RUN (no changes will be written)")
  console.log()

  // 1. Read spreadsheet
  const sheets = sheetsClient()
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB_NAME}'`,
    valueRenderOption: "UNFORMATTED_VALUE",
  })
  const rows: (string | number | null)[][] =
    (resp.data.values as (string | number | null)[][]) ?? []
  if (rows.length < 3) {
    console.error("Sheet appears empty or too small.")
    process.exit(1)
  }

  // Row 1 (index 0) = month name spans — ignored
  // Row 2 (index 1) = headers: Category | Actual ID | date1 | date2 | ...
  const headerRow = rows[1] ?? []

  // Find week columns that are in the current month and ≤ today
  type WeekCol = { colIdx: number; date: Date }
  const weekCols: WeekCol[] = []
  for (let c = 2; c < headerRow.length; c++) {
    const raw = headerRow[c]
    // Headers are stored as ISO strings ("2026-06-02") in column B data
    // but displayed as "2 Jun" — we stored ISO dates in colISO which maps
    // to the actual cell value.  Google returns UNFORMATTED_VALUE so dates
    // come back as serial numbers.  We need to convert.
    // Serial number 0 = Dec 30 1899 in Google Sheets
    if (typeof raw === "number") {
      // Excel/Sheets serial date → JS Date
      const ms = (raw - 25569) * 86400000 // days since Unix epoch (Jan 1 1970)
      const d = new Date(ms)
      d.setHours(0, 0, 0, 0)
      if (monthKey(d) === currentMonth && d <= today) {
        weekCols.push({ colIdx: c, date: d })
      }
    } else if (typeof raw === "string") {
      const d = parseISODate(raw)
      if (d && monthKey(d) === currentMonth && d <= today) {
        weekCols.push({ colIdx: c, date: d })
      }
    }
  }

  if (weekCols.length === 0) {
    console.log(
      "No week columns found for the current month up to today. Nothing to sync.",
    )
    process.exit(0)
  }

  console.log(
    `Week columns to sum: ${weekCols.map((w) => toISO(w.date)).join(", ")}`,
  )
  console.log()

  // 3. Build per-category sums (skip group headers and subtotal rows)
  type CategoryAmount = { actualId: string; name: string; amountCents: number }
  const updates: CategoryAmount[] = []

  console.log("DEBUG first 5 data rows:")
  for (let r = 2; r < Math.min(rows.length, 7); r++) {
    const row = rows[r] ?? []
    console.log(
      `  row[${r}]: col0=${JSON.stringify(row[0])} col1=${JSON.stringify(row[1])}`,
    )
  }
  console.log()

  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? []
    const name = String(row[0] ?? "").trim()
    const actualId = String(row[1] ?? "").trim()

    // Skip group headers (no Actual ID), subtotal rows, empty rows
    if (!name || !actualId || actualId === "Actual ID") continue

    let sum = 0
    for (const wc of weekCols) {
      const val = row[wc.colIdx]
      if (typeof val === "number" && val !== 0) sum += val
      else if (typeof val === "string") {
        const n = parseFloat(val)
        if (!isNaN(n)) sum += n
      }
    }

    // Actual Budget stores amounts as integer cents (e.g. $100.00 = 10000)
    updates.push({ actualId, name, amountCents: Math.round(sum * 100) })
  }

  if (updates.length === 0) {
    console.log(
      "No categories with Actual IDs found in sheet. Nothing to sync.",
    )
    process.exit(0)
  }

  console.log(`Categories with amounts to set (${updates.length}):`)
  for (const u of updates) {
    console.log(`  ${u.name.padEnd(35)} $${(u.amountCents / 100).toFixed(2)}`)
  }
  console.log()

  if (DRY_RUN) {
    console.log("DRY RUN — skipping Actual Budget write.")
    process.exit(0)
  }

  // 4. Connect to Actual Budget and set budgets
  console.log("Connecting to Actual Budget...")
  await api.init({
    serverURL: ACTUAL_SERVER!,
    password: ACTUAL_PASSWORD!,
    dataDir: ACTUAL_DATA,
  })
  await api.downloadBudget(ACTUAL_SYNC_ID!)

  const month = currentMonth // "2026-06" format expected by api.setBudget

  const results = await Promise.allSettled(
    updates.map((u) => api.setBudgetAmount(month, u.actualId, u.amountCents)),
  )

  let applied = 0
  let errors = 0
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    const u = updates[i]!
    if (r.status === "fulfilled") {
      console.log(`  ✓ ${u.name}: $${(u.amountCents / 100).toFixed(2)}`)
      applied++
    } else {
      console.error(`  ✗ ${u.name}: ${(r.reason as Error).message}`)
      errors++
    }
  }

  await api.sync()
  await api.shutdown()

  console.log(`\nDone. ${applied} budgets updated, ${errors} errors.`)
  if (errors > 0) process.exit(1)
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})

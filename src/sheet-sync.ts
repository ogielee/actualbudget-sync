/**
 * sheet-sync: Weekly Google Sheets → Actual Budget sync
 *
 * Reads the "Budget 2026 v2" tab from Google Sheets, finds the weekly column
 * whose Monday-dated week contains today, and sets budgets for that column's
 * month — summing that month's weekly columns up to and including the current
 * week.  Anchoring to the week (not the calendar month) means a week that
 * straddles a month boundary keeps refreshing its own month until it ends
 * (e.g. the Jun 29 week stays current, and updates June, through Jul 5).  The
 * operation is idempotent — running it multiple times or editing a past week in
 * the sheet and re-running will produce the same correct result.
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
  if (env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    const auth = new google.auth.GoogleAuth({
      // strip a UTF-8 BOM that Windows tools may prepend to the secret
      credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/^﻿/, "")),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    })
    return google.sheets({ version: "v4", auth })
  }
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

/** Return YYYY-MM for a date, read in UTC so it doesn't shift by local timezone. */
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
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
  // Derive today in NZ time so week columns aren't excluded during the NZ
  // morning hours when GitHub Actions (UTC) is still on the previous date.
  const today = new Date(
    new Date().toLocaleDateString("en-CA", { timeZone: "Pacific/Auckland" }),
  )

  console.log(`\n=== Sheet Budget Sync ===`)
  console.log(`Date:  ${toISO(today)}`)
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

  // Parse every week-header column into { colIdx, date }, keeping the weeks
  // whose Monday date is on or before today. Columns may span multiple months.
  const MS_PER_DAY = 86400000
  type WeekCol = { colIdx: number; date: Date }
  const pastWeeks: WeekCol[] = []
  for (let c = 2; c < headerRow.length; c++) {
    const raw = headerRow[c]
    // Google returns UNFORMATTED_VALUE, so date headers come back as serial
    // numbers; older sheets may store ISO strings.
    let d: Date | null = null
    if (typeof raw === "number") {
      // Serial 0 = Dec 30 1899; 25569 = days from there to the Unix epoch.
      // Build at UTC midnight (Math.round drops float dust) so the month/day is
      // stable regardless of the machine's local timezone.
      d = new Date((Math.round(raw) - 25569) * MS_PER_DAY)
    } else if (typeof raw === "string") {
      d = parseISODate(raw)
    }
    if (d && d <= today) pastWeeks.push({ colIdx: c, date: d })
  }

  // The current week is the most recent Monday-dated column on or before today,
  // provided today still falls inside it (Mon..Mon+6). Anchoring to the week
  // rather than the calendar month keeps a straddling week refreshing its own
  // month after the month rolls over (the Jun 29 week is current on Jul 1–5).
  let latest: WeekCol | undefined
  for (const w of pastWeeks) {
    if (!latest || w.date > latest.date) latest = w
  }
  const currentWeek =
    latest && (today.getTime() - latest.date.getTime()) / MS_PER_DAY <= 6
      ? latest
      : undefined

  if (!currentWeek) {
    console.log("No week column contains today's date. Nothing to sync.")
    process.exit(0)
  }

  // Budget is written to the month the current week's Monday belongs to, summing
  // that month's weekly columns up to and including the current week.
  const targetMonth = monthKey(currentWeek.date)
  const weekCols = pastWeeks.filter(
    (w) => monthKey(w.date) === targetMonth && w.date <= currentWeek.date,
  )

  console.log(`Target month: ${targetMonth}`)
  console.log(
    `Current week: ${toISO(currentWeek.date)} (contains today ${toISO(today)})`,
  )
  console.log(
    `Week columns to sum: ${weekCols.map((w) => toISO(w.date)).join(", ")}`,
  )
  console.log()

  // 3. Connect to Actual Budget and build category name → id map
  console.log("Connecting to Actual Budget...")
  await api.init({
    serverURL: ACTUAL_SERVER!,
    password: ACTUAL_PASSWORD!,
    dataDir: ACTUAL_DATA,
  })
  await api.downloadBudget(ACTUAL_SYNC_ID!)

  const categories = await api.getCategories()
  // Actual Budget category names have frequency suffixes like "(W)", "(M)", "(Q)", "(Y)".
  // Strip them so "Mortgage (W)" matches the sheet row "Mortgage".
  const categoryByName = new Map(
    categories.map((c: { id: string; name: string }) => [
      c.name
        .trim()
        .replace(/\s*\([A-Z]\)$/i, "")
        .toLowerCase(),
      c.id,
    ]),
  )

  // 4. Build per-category sums; match sheet rows to Actual categories by name.
  //    Also capture the INCOME TOTAL row for the hold-for-next-month logic.
  type CategoryAmount = { actualId: string; name: string; amountCents: number }
  const updates: CategoryAmount[] = []
  let incomeTotalCents = 0
  let incomeRowFound = false

  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? []
    const name = String(row[0] ?? "").trim()
    if (!name) continue

    if (name.toLowerCase() === "income total") {
      let sum = 0
      for (const wc of weekCols) {
        const val = row[wc.colIdx]
        if (typeof val === "number") sum += val
        else if (typeof val === "string") {
          const n = parseFloat(val)
          if (!isNaN(n)) sum += n
        }
      }
      incomeTotalCents = Math.round(sum * 100)
      incomeRowFound = true
      continue
    }

    const actualId = categoryByName.get(name.toLowerCase())
    if (!actualId) continue // group header or unrecognised row — skip silently

    let sum = 0
    for (const wc of weekCols) {
      const val = row[wc.colIdx]
      if (typeof val === "number") sum += val
      else if (typeof val === "string") {
        const n = parseFloat(val)
        if (!isNaN(n)) sum += n
      }
    }

    updates.push({ actualId, name, amountCents: Math.round(sum * 100) })
  }

  if (updates.length === 0) {
    console.log(
      "No sheet rows matched any Actual Budget category. Nothing to sync.",
    )
    await api.shutdown()
    process.exit(0)
  }

  console.log(`Categories to sync (${updates.length}):`)
  for (const u of updates) {
    console.log(`  ${u.name.padEnd(35)} $${(u.amountCents / 100).toFixed(2)}`)
  }
  console.log()

  const month = targetMonth // "2026-06" format expected by api.setBudget

  if (DRY_RUN) {
    console.log("DRY RUN — skipping category budget writes.")
  } else {
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

    if (errors > 0) {
      await api.sync()
      await api.shutdown()
      console.log(`\nDone. ${applied} budgets updated, ${errors} errors.`)
      process.exit(1)
    }

    console.log(`\n${applied} budgets updated.`)
  }

  // ── Hold for next month ────────────────────────────────────────────────────
  console.log(`\n=== Hold for Next Month ===`)

  if (!incomeRowFound) {
    console.log(
      "  INCOME TOTAL row not found in sheet — skipping hold adjustment.",
    )
  } else {
    const budgetMonth = await api.getBudgetMonth(month)
    const forNextMonth: number = budgetMonth.forNextMonth
    const toBudget: number = budgetMonth.toBudget
    // available = forNextMonth + toBudget is invariant under hold shifts:
    // resetBudgetHold moves forNextMonth → toBudget; holdBudgetForNextMonth
    // moves it back. The sum never changes, making the logic idempotent.
    const available = forNextMonth + toBudget

    console.log(
      `  Income total (month to date): $${(incomeTotalCents / 100).toFixed(2)}`,
    )
    console.log(
      `  Held for next month:          $${(forNextMonth / 100).toFixed(2)}`,
    )
    console.log(
      `  To budget:                    $${(toBudget / 100).toFixed(2)}`,
    )
    console.log(
      `  Available (held + toBudget):  $${(available / 100).toFixed(2)}`,
    )

    if (available >= incomeTotalCents) {
      const newHold = available - incomeTotalCents
      if (!DRY_RUN) {
        // Reset first so toBudget has the full available pool before we re-hold.
        // Without this, holdBudgetForNextMonth may return false when toBudget
        // is negative (over-budget after category writes).
        await api.resetBudgetHold(month)
        if (newHold > 0) {
          await api.holdBudgetForNextMonth(month, newHold)
        }
      }
      console.log(
        `  ${DRY_RUN ? "[DRY RUN] Would release" : "Released"} $${(incomeTotalCents / 100).toFixed(2)} to current month (now over-budget by this amount)`,
      )
      console.log(
        `  ${DRY_RUN ? "[DRY RUN] Would re-hold" : "Re-held "}  $${(newHold / 100).toFixed(2)} for next month`,
      )
    } else {
      if (!DRY_RUN && available > 0) {
        await api.holdBudgetForNextMonth(month, available)
      }
      console.log(
        `  ${DRY_RUN ? "[DRY RUN] Would hold" : "Held"} full available $${(available / 100).toFixed(2)} for next month (less than income total $${(incomeTotalCents / 100).toFixed(2)})`,
      )
    }
  }

  if (!DRY_RUN) {
    await api.sync()
  }
  await api.shutdown()

  console.log(`\nDone.`)
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})

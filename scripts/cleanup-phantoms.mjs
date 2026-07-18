// Phase 2 cleanup: after migrate-imported-ids.mjs + a fresh sync run, any
// (date, amount, description) bucket that had more Actual rows than real
// Akahu transactions (the groups migrate-imported-ids.mjs deliberately left
// untouched — see its header comment) now has BOTH the original stale
// duplicate row(s) AND a freshly-imported, correctly-id'd row for the same
// real transaction. This deletes the excess stale rows, and any
// transfer-linked counterpart they created, so each bucket ends up with
// exactly one Actual row per real Akahu transaction.
//
// Every deleted row's full JSON is logged BEFORE deletion so the action is
// reversible without a full data restore.
//
// Usage:
//   node scripts/cleanup-phantoms.mjs [--window-days=35]           (dry run)
//   node scripts/cleanup-phantoms.mjs [--window-days=35] --apply   (deletes + undo log)
import { writeFileSync } from "node:fs"
import {
  ACCOUNTS,
  akahuTransactions,
  loadActualApi,
  loadEnv,
  initActual,
  toNZDate,
} from "./reconcile-lib.mjs"

const args = process.argv.slice(2)
const windowDays = Number(
  args.find((a) => a.startsWith("--window-days="))?.split("=")[1] ?? 35,
)
const apply = args.includes("--apply")

const REAL_ID = /^trans_/
// Same pattern migrate-imported-ids.mjs uses to recognize an old-scheme
// date+amount+counter id — the ONLY shape eligible for deletion here.
const ORDINAL_ID = /^\d{8}-?-?\d+-\d+$/

loadEnv()
const api = await loadActualApi()
await initActual(api)
const q = async (build) => (await api.aqlQuery(build(api.q))).data

const startIso = new Date(Date.now() - windowDays * 86400000).toISOString()
const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
const logPath = `C:\\Users\\orlan\\akahu-sync\\logs\\cleanup-phantoms-${timestamp}-${apply ? "applied" : "dryrun"}.json`

// Resolve transfer counterparts across the whole budget (not just synced
// accounts — see the "brokenTransfers" invariant in reconcile.mjs for why).
const everyRow = await q((qq) =>
  qq("transactions")
    .select(["id", "account", "amount", "transfer_id", "imported_id", "date", "notes", "cleared", "payee", "is_child", "is_parent"])
    .options({ splits: "all" })
    .limit(50000),
)
const byId = new Map(everyRow.map((t) => [t.id, t]))

const toDelete = new Map() // id -> row (dedup across accounts/pairs)
const undoLog = []

for (const acct of ACCOUNTS) {
  console.log(`\n=== ${acct.name} ===`)

  const actualRows = everyRow.filter(
    (t) => t.account === acct.actualId && t.date >= toNZDate(startIso) && !t.is_child,
  )
  const akTxns = await akahuTransactions(acct.akahuId, startIso)

  const bucketKey = (date, amount, text) => `${date}|${amount}|${text}`
  const actualBuckets = new Map()
  for (const t of actualRows) {
    const key = bucketKey(t.date, t.amount, t.notes ?? "")
    ;(actualBuckets.get(key) ?? actualBuckets.set(key, []).get(key)).push(t)
  }
  const akahuCounts = new Map()
  for (const t of akTxns) {
    const key = bucketKey(toNZDate(t.date), Math.round(t.amount * 100), t.description)
    akahuCounts.set(key, (akahuCounts.get(key) ?? 0) + 1)
  }

  for (const [key, rows] of actualBuckets) {
    // A blank notes key can't disambiguate anything (many unrelated real
    // transactions could share it) — never treat such a bucket as
    // over-populated. This also protects manually-entered transactions,
    // which commonly have no notes.
    const bucketNotes = key.split("|").slice(2).join("|")
    if (bucketNotes === "") continue

    const akahuCount = akahuCounts.get(key) ?? 0
    // Require positive confirmation of at least one real Akahu transaction
    // before ever shrinking a bucket. A transaction dated right at the
    // rolling window's edge can be clipped out of THIS run's Akahu fetch
    // depending on exactly when the script runs, making a genuine, singular
    // transaction look like an unmatched duplicate with zero real
    // replacement — deleting it would be outright data loss, not cleanup.
    if (akahuCount === 0) continue

    const realRows = rows.filter((t) => REAL_ID.test(t.imported_id ?? ""))
    // Only ever a deletion candidate if the sync itself created the row
    // under the old unstable scheme. A row with NO imported_id at all was
    // never touched by the sync — it's a manual entry (e.g. a hand-split
    // income transaction) — and must never be auto-deleted here.
    const staleRows = rows.filter(
      (t) =>
        typeof t.imported_id === "string" &&
        ORDINAL_ID.test(t.imported_id),
    )

    // Deficit after crediting real (already correctly linked) rows first.
    const excess = rows.length - akahuCount
    if (excess <= 0) continue // nothing extra in this bucket

    // Only ever delete stale (unmigrated ordinal-id) rows — never a row
    // that already carries a real Akahu id.
    const deleteCount = Math.min(excess, staleRows.length)
    const victims = staleRows
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .slice(0, deleteCount)

    if (victims.length === 0) continue

    console.log(
      `  BUCKET ${key.split("|").slice(0, 2).join("|")} "${key.split("|")[2]}": ${rows.length} actual (${realRows.length} real, ${staleRows.length} stale) vs ${akahuCount} akahu -> deleting ${victims.length}`,
    )

    for (const victim of victims) {
      if (toDelete.has(victim.id)) continue

      // A transfer counterpart's notes are copied from the OTHER side by
      // Actual's own transfer-payee mechanism, so they don't reflect this
      // account's real Akahu feed — a counterpart can legitimately show
      // "0 akahu txns" here even when it's correct. If either side of the
      // pair already carries a real Akahu id, the pair has already been
      // resolved correctly elsewhere (e.g. by the migration matching the
      // OTHER leg by its own account's text) — deleting either row here
      // would destroy a already-correct transaction. Skip the whole pair.
      const mate = victim.transfer_id ? byId.get(victim.transfer_id) : undefined
      const mateIsMutual = mate && mate.transfer_id === victim.id
      if (mateIsMutual && (REAL_ID.test(mate.imported_id ?? "") || REAL_ID.test(victim.imported_id ?? ""))) {
        console.log(
          `      SKIP ${victim.id} — transfer counterpart ${mate.id} (or this row) already has a real id; leaving pair untouched`,
        )
        continue
      }

      toDelete.set(victim.id, victim)
      undoLog.push({ ...victim, _reason: "excess stale row in over-populated bucket" })
      console.log(`      DELETE ${victim.id} imp=${victim.imported_id} amount=${(victim.amount / 100).toFixed(2)} notes="${victim.notes ?? ""}"`)

      // Pull in the transfer counterpart too, so we never leave an orphan
      // leg (this is what makes the old BNZ<->ASB phantom pairs symmetric).
      if (mateIsMutual && !toDelete.has(mate.id)) {
        toDelete.set(mate.id, mate)
        undoLog.push({ ...mate, _reason: `transfer counterpart of deleted row ${victim.id}` })
        console.log(`      DELETE ${mate.id} (transfer counterpart, account=${mate.account}) amount=${(mate.amount / 100).toFixed(2)}`)
      }
    }
  }

  // Tier 2 — (date, amount) only, ignoring notes text. Actual's server
  // appears to null out `notes` on import when it would duplicate the
  // payee/merchant name, so the SAME real transaction can show notes="Kindo
  // Hobsonville" on an old stale row and notes=null (with imported_payee
  // carrying the merchant name instead) on the fresh real-id row — the
  // Tier 1 pass above requires exact notes-text equality, so it can never
  // see these as the same transaction (found in production 2026-07-17: 186
  // real-id rows with null notes despite a populated imported_payee).
  //
  // Only safe when, for this exact (date, amount): exactly one stale row
  // (with non-empty notes — ruling out the blank-notes/manual-entry
  // pattern) and exactly one real row remain un-deleted, AND the raw Akahu
  // count at this (date, amount) confirms an actual excess. Two distinct
  // real transactions coincidentally sharing an amount+date would show
  // akahuCount >= 2, correctly blocking this tier.
  const akahuDateAmountCounts = new Map()
  for (const t of akTxns) {
    const key = `${toNZDate(t.date)}|${Math.round(t.amount * 100)}`
    akahuDateAmountCounts.set(key, (akahuDateAmountCounts.get(key) ?? 0) + 1)
  }
  const remainingByDateAmount = new Map()
  for (const t of actualRows) {
    if (toDelete.has(t.id)) continue
    const key = `${t.date}|${t.amount}`
    ;(remainingByDateAmount.get(key) ?? remainingByDateAmount.set(key, []).get(key)).push(t)
  }
  for (const [key, rows] of remainingByDateAmount) {
    const akahuCount = akahuDateAmountCounts.get(key) ?? 0
    if (akahuCount === 0 || rows.length <= akahuCount) continue

    const realRows = rows.filter((t) => REAL_ID.test(t.imported_id ?? ""))
    const staleRows = rows.filter(
      (t) =>
        typeof t.imported_id === "string" &&
        ORDINAL_ID.test(t.imported_id) &&
        t.notes,
    )
    if (realRows.length !== 1 || staleRows.length !== 1) continue

    const victim = staleRows[0]
    const mate = victim.transfer_id ? byId.get(victim.transfer_id) : undefined
    const mateIsMutual = mate && mate.transfer_id === victim.id
    if (mateIsMutual && (REAL_ID.test(mate.imported_id ?? "") || REAL_ID.test(victim.imported_id ?? ""))) {
      console.log(`  TIER2 SKIP ${victim.id} — transfer counterpart already has a real id; leaving pair untouched`)
      continue
    }

    console.log(
      `  TIER2 BUCKET ${key}: notes mismatch ("${victim.notes}" vs real row's null/differing notes) but (date,amount) confirms 1 excess -> deleting stale row`,
    )
    toDelete.set(victim.id, victim)
    undoLog.push({ ...victim, _reason: "excess stale row, matched by (date,amount) after notes-normalization mismatch (Tier 2)" })
    console.log(`      DELETE ${victim.id} imp=${victim.imported_id} amount=${(victim.amount / 100).toFixed(2)} notes="${victim.notes}"`)
    if (mateIsMutual && !toDelete.has(mate.id)) {
      toDelete.set(mate.id, mate)
      undoLog.push({ ...mate, _reason: `transfer counterpart of deleted row ${victim.id} (Tier 2)` })
      console.log(`      DELETE ${mate.id} (transfer counterpart, account=${mate.account}) amount=${(mate.amount / 100).toFixed(2)}`)
    }
  }
}

writeFileSync(logPath, JSON.stringify(undoLog, null, 2), "utf8")

console.log(`\n=== SUMMARY ===`)
console.log(`  rows to delete: ${toDelete.size}`)
console.log(`  undo log (full row JSON, pre-deletion): ${logPath}`)

if (apply) {
  for (const id of toDelete.keys()) {
    await api.deleteTransaction(id)
  }
  console.log(`  deleted ${toDelete.size} rows.`)
} else {
  console.log(`\n  Dry run only — re-run with --apply to delete.`)
}

await api.shutdown()

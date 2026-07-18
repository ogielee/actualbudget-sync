// Fixes a specific duplicate pattern found 2026-07-17: for a recurring
// transfer (e.g. weekly BNZ standing orders), TWO complete pairs can exist
// for what should be ONE real transaction — one old/stale row on each side
// cross-linked to the OTHER side's real-id row, instead of the two real
// rows being linked to each other:
//
//   ASB real   <-transfer_id-> BNZ ordinal
//   ASB ordinal <-transfer_id-> BNZ real
//
// Both pairs look individually valid (each has one real, one ordinal side,
// mutually linked), so cleanup-phantoms.mjs's "don't touch a pair where
// either side already has a real id" guard protects BOTH pairs — it can't
// tell this apart from a correct pair without comparing across pairs. This
// script does that comparison: for each (date, amount) bucket with exactly
// 2 rows on each side (1 real + 1 ordinal each) forming this crossed
// pattern, it relinks the two REAL rows to each other and deletes the two
// ordinal rows.
//
// Usage:
//   node scripts/fix-crossed-transfer-pairs.mjs                (dry run)
//   node scripts/fix-crossed-transfer-pairs.mjs --apply         (applies + undo log)
import { writeFileSync } from "node:fs"
import { loadActualApi, loadEnv, initActual } from "./reconcile-lib.mjs"

const apply = process.argv.includes("--apply")
const ORDINAL_ID = /^\d{8}-?-?\d+-\d+$/
const REAL_ID = /^trans_/

const ASB = "10170e5c-b4c0-423f-9125-b1b74a9dcb69"
const BNZ = "d2edf7ee-2fb7-43e5-999d-1e91c58f95c6"
const TFR_NOTE = /TFR TO bnz/i

loadEnv()
const api = await loadActualApi()
await initActual(api)
const q = async (build) => (await api.aqlQuery(build(api.q))).data

const everyRow = await q((qq) =>
  qq("transactions")
    .select(["*"])
    .options({ splits: "all" })
    .limit(50000),
)
const byId = new Map(everyRow.map((t) => [t.id, t]))

const asbTfr = everyRow.filter(
  (t) => t.account === ASB && !t.is_child && TFR_NOTE.test(t.notes ?? ""),
)
const byDateAmount = new Map()
for (const t of asbTfr) {
  const key = `${t.date}|${t.amount}`
  ;(byDateAmount.get(key) ?? byDateAmount.set(key, []).get(key)).push(t)
}

const fixes = []
const undoLog = []

for (const [key, rows] of byDateAmount) {
  if (rows.length !== 2) continue
  const real = rows.find((t) => REAL_ID.test(t.imported_id ?? ""))
  const ordinal = rows.find((t) => ORDINAL_ID.test(t.imported_id ?? ""))
  if (!real || !ordinal) continue

  const realMate = real.transfer_id ? byId.get(real.transfer_id) : undefined
  const ordinalMate = ordinal.transfer_id ? byId.get(ordinal.transfer_id) : undefined
  if (!realMate || !ordinalMate) continue
  if (realMate.transfer_id !== real.id || ordinalMate.transfer_id !== ordinal.id) continue
  if (realMate.account !== BNZ || ordinalMate.account !== BNZ) continue

  // Crossed pattern: ASB real -> BNZ ordinal, ASB ordinal -> BNZ real.
  const bnzReal = [realMate, ordinalMate].find((t) => REAL_ID.test(t.imported_id ?? ""))
  const bnzOrdinal = [realMate, ordinalMate].find((t) => ORDINAL_ID.test(t.imported_id ?? ""))
  if (!bnzReal || !bnzOrdinal) continue
  if (realMate.id !== bnzOrdinal.id || ordinalMate.id !== bnzReal.id) continue // must actually be crossed, not already correct

  console.log(`\n=== ${key} "${real.notes}" ===`)
  console.log(`  ASB real ${real.id} (imp=${real.imported_id}) currently -> BNZ ordinal ${bnzOrdinal.id} (imp=${bnzOrdinal.imported_id})`)
  console.log(`  ASB ordinal ${ordinal.id} (imp=${ordinal.imported_id}) currently -> BNZ real ${bnzReal.id} (imp=${bnzReal.imported_id})`)
  console.log(`  FIX: relink ASB real ${real.id} <-> BNZ real ${bnzReal.id}; delete ASB ordinal ${ordinal.id} + BNZ ordinal ${bnzOrdinal.id}`)

  fixes.push({ asbReal: real, bnzReal, asbOrdinal: ordinal, bnzOrdinal })
  undoLog.push({ _reason: "deleted as redundant ordinal (crossed pair fix)", ...ordinal })
  undoLog.push({ _reason: "deleted as redundant ordinal (crossed pair fix)", ...bnzOrdinal })
  undoLog.push({ _reason: "transfer_id before relink", id: real.id, old_transfer_id: real.transfer_id })
  undoLog.push({ _reason: "transfer_id before relink", id: bnzReal.id, old_transfer_id: bnzReal.transfer_id })
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
const logPath = `C:\\Users\\orlan\\akahu-sync\\logs\\fix-crossed-transfer-pairs-${timestamp}-${apply ? "applied" : "dryrun"}.json`
writeFileSync(logPath, JSON.stringify(undoLog, null, 2), "utf8")

console.log(`\n=== SUMMARY ===`)
console.log(`  crossed pairs found: ${fixes.length}`)
console.log(`  log: ${logPath}`)

const fullFields = (row) => ({
  is_parent: row.is_parent,
  is_child: row.is_child,
  parent_id: row.parent_id,
  account: row.account,
  category: row.category,
  amount: row.amount,
  payee: row.payee,
  notes: row.notes,
  date: row.date,
  starting_balance_flag: row.starting_balance_flag,
  cleared: row.cleared,
  reconciled: row.reconciled,
  tombstone: row.tombstone,
  imported_id: row.imported_id,
  imported_payee: row.imported_payee,
})

if (apply) {
  // Pass A only: unlink the ordinals and relink the reals to each other.
  // Deliberately NO deletes here — deleteTransaction on a row that is still
  // transfer_id-linked cascades to its partner, which is exactly what
  // destroyed 12 real transactions on 2026-07-17. Run cleanup-phantoms.mjs
  // separately (Pass B) once these ordinals are confirmed unlinked.
  //
  // payee: null on the ordinals is required, not optional — leaving the old
  // transfer-type payee in place while clearing transfer_id was confirmed
  // (2026-07-18) to make Actual's server auto-create a brand new counterpart
  // transaction to satisfy that payee, silently reintroducing a linked pair
  // that then blocks Pass B's delete (same cascade risk all over again).
  for (const { asbReal, bnzReal, asbOrdinal, bnzOrdinal } of fixes) {
    await api.updateTransaction(asbOrdinal.id, { ...fullFields(asbOrdinal), transfer_id: null, payee: null })
    await api.updateTransaction(bnzOrdinal.id, { ...fullFields(bnzOrdinal), transfer_id: null, payee: null })
    await api.updateTransaction(asbReal.id, { ...fullFields(asbReal), transfer_id: bnzReal.id })
    await api.updateTransaction(bnzReal.id, { ...fullFields(bnzReal), transfer_id: asbReal.id })
  }
  console.log(`  applied ${fixes.length} unlink/relink fixes (Pass A only — no deletes).`)
  console.log(`  Verify in a FRESH process, then run cleanup-phantoms.mjs separately for Pass B (deletion).`)
} else {
  console.log(`\n  Dry run only — re-run with --apply to execute.`)
}

await api.shutdown()

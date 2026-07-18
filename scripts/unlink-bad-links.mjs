// Repairs the 3 wrong transfer links left by the 2026-07-17 recovery sync
// (race + unbounded-date-window bugs in the linking pass, both since fixed
// in src/Sync.ts and src/Actual.ts):
//
//   ASB Jul-06 -50  <-mutual->  BNZ Jul-13 +50   (wrong week)
//   ASB Jun-29 -50  --one-way-> BNZ Jul-13 +50   (dangling, non-mutual)
//
// Fix: UPDATES ONLY, no deletes (deletes on linked rows cascade — the root
// of tonight's data loss; unlinking via update does not). Each row gets
// transfer_id cleared AND its payee restored to the original imported
// payee in the same call, so no row is ever left in the incoherent
// "transfer payee but no transfer_id" state that could invite Actual's
// runTransfers to auto-create a counterpart.
//
// After this, one sync run re-imports the 3 missing "jointipsave" credits
// (their delete rule is now retired) and the fixed linking pass pairs
// everything by week.
//
// Usage:
//   node scripts/unlink-bad-links.mjs           (dry run)
//   node scripts/unlink-bad-links.mjs --apply   (applies + undo log)
import { writeFileSync } from "node:fs"
import { loadActualApi, loadEnv, initActual } from "./reconcile-lib.mjs"

const apply = process.argv.includes("--apply")

// payee ids from the recovery sync's own import log (resync-recovery-1.txt):
const PAYEE_ASB_TFR_PAYPH = "cd2a60d8-54d0-422a-8c9c-080e5e61ee94" // "Tfr to Bnz Joint Sav Payphairfre"
const PAYEE_BNZ_OMLEE_PAYPH = "a97340b2-80e8-4db9-a3a6-12ff660f1417" // "Om Lee Payphairfre"

const TARGETS = [
  { imported_id: "trans_cmr81q3d10rz402lefi2v9nwa", label: "ASB Jul-06 -50", payee: PAYEE_ASB_TFR_PAYPH },
  { imported_id: "trans_cmrilr1x20o8a02jpeaz783r5", label: "BNZ Jul-13 +50", payee: PAYEE_BNZ_OMLEE_PAYPH },
  { imported_id: "trans_cmqy1lekj146e02joc4y4ddw2", label: "ASB Jun-29 -50", payee: PAYEE_ASB_TFR_PAYPH },
]

loadEnv()
const api = await loadActualApi()
await initActual(api)
const q = async (b) => (await api.aqlQuery(b(api.q))).data

const undoLog = []
const plan = []

for (const target of TARGETS) {
  const rows = await q((qq) =>
    qq("transactions").filter({ imported_id: target.imported_id }).select(["*"]).options({ splits: "all" }),
  )
  if (rows.length !== 1) {
    console.log(`ABORT: expected exactly 1 row for ${target.imported_id} (${target.label}), found ${rows.length}`)
    await api.shutdown()
    process.exit(1)
  }
  const row = rows[0]
  if (!row.transfer_id) {
    console.log(`SKIP ${target.label} (${row.id}) — already unlinked`)
    continue
  }
  console.log(`${target.label} (${row.id}): transfer_id ${row.transfer_id} -> null, payee ${row.payee} -> ${target.payee}`)
  undoLog.push({ _reason: "before unlink", ...row })
  plan.push({ row, target })
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
const logPath = `C:\\Users\\orlan\\akahu-sync\\logs\\unlink-bad-links-${timestamp}-${apply ? "applied" : "dryrun"}.json`
writeFileSync(logPath, JSON.stringify(undoLog, null, 2), "utf8")
console.log(`\nrows to unlink: ${plan.length}   log: ${logPath}`)

if (apply) {
  for (const { row, target } of plan) {
    await api.updateTransaction(row.id, {
      is_parent: row.is_parent,
      is_child: row.is_child,
      parent_id: row.parent_id,
      account: row.account,
      category: row.category,
      amount: row.amount,
      payee: target.payee,
      notes: row.notes,
      date: row.date,
      starting_balance_flag: row.starting_balance_flag,
      cleared: row.cleared,
      reconciled: row.reconciled,
      tombstone: row.tombstone,
      imported_id: row.imported_id,
      imported_payee: row.imported_payee,
      transfer_id: null,
    })
  }
  console.log(`applied ${plan.length} unlink updates. Verify in a FRESH process (same-process re-reads can be stale).`)
} else {
  console.log("\nDry run only — re-run with --apply to execute.")
}

await api.shutdown()

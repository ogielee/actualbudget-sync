// Phase 3: retire (tombstone) the Actual rules that conflict with the new
// --transfer-match sync-side linking mechanism. Actual's rule API has no
// enable/disable flag — updateRule with tombstone:true is the only way to
// deactivate a rule, so this is a soft-delete. Full rule JSON is logged
// before the change so it can be recreated via api.createRule if needed.
//
// Usage:
//   node scripts/retire-rules.mjs           (dry run)
//   node scripts/retire-rules.mjs --apply   (retires + undo log)
import { writeFileSync } from "node:fs"
import { loadActualApi, loadEnv, initActual } from "./reconcile-lib.mjs"

const apply = process.argv.includes("--apply")

// Round 1 (applied 2026-07-17): the two payee-rewrite rules that conflicted
// with --transfer-match:
//   8e10c316-7d6f-44c7-97f7-32d43e7a841a  (TFR TO bnz -> BNZ Savings)
//   a6de29b1-6b09-4cff-82b3-b68dbf5b225e  (Rabodirect -> Rabo Premiums Saver)
//
// Round 2: the three delete-transaction rules. These were long thought
// inert during sync, but that was only because Actual's fuzzy matcher
// absorbed the incoming rows before the delete could land. With
// forceAddTransaction (Phase 4) disabling that absorption, the delete
// rules NOW ACTUALLY FIRE on import — confirmed 2026-07-17 when three real
// "OM LEE jointipsave" BNZ credits were silently dropped during a resync.
// They're also dangerous on any manual "apply rules" in the UI, since
// their conditions match legitimate transfer-leg notes.
const RETIRE_IDS = [
  "bc31dfe9-5ecd-4464-b644-7ec7b8c06fd2", // BNZ + notes contains jointipsave -> delete-transaction
  "63d8b29e-bc4f-4185-8482-a672fc5dc1ae", // BNZ + notes contains kenzbdayvaca -> delete-transaction
  "0675cc7a-806f-410e-8eea-d2483b8721d2", // imported_payee "Payment Received Cc Payment" -> delete-transaction
]

loadEnv()
const api = await loadActualApi()
await initActual(api)

const rules = await api.getRules()
const targets = rules.filter((r) => RETIRE_IDS.includes(r.id))

if (targets.length !== RETIRE_IDS.length) {
  console.log(`SKIP — expected ${RETIRE_IDS.length} rules, found ${targets.length}. Aborting without changes.`)
  await api.shutdown()
  process.exit(1)
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
const logPath = `C:\\Users\\orlan\\akahu-sync\\logs\\retire-rules-${timestamp}-${apply ? "applied" : "dryrun"}.json`
writeFileSync(logPath, JSON.stringify(targets, null, 2), "utf8")

console.log(`=== ${apply ? "RETIRING" : "WOULD RETIRE"} ${targets.length} rule(s) ===`)
for (const r of targets) {
  console.log(`  ${r.id}`)
  console.log(`    conditions: ${JSON.stringify(r.conditions)}`)
  console.log(`    actions: ${JSON.stringify(r.actions)}`)
  if (apply) {
    // better-sqlite3 rejects native JS booleans as bind params ("Invalid
    // field type true for sql") — this API's tombstone column wants 1/0.
    await api.updateRule({ ...r, tombstone: 1 })
  }
}

console.log(`\nfull rule JSON logged to: ${logPath}`)
if (!apply) console.log("\nDry run only — re-run with --apply to retire.")

await api.shutdown()

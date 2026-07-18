// Removes the 12 "resurrected" ordinal-id duplicate rows discovered
// 2026-07-18: rows deleted in earlier cleanup rounds reappeared with the
// SAME old-scheme imported_ids but NEW row ids (CRDT sync replay across
// tonight's many rapid operations — current code cannot mint ordinal ids
// for cleared transactions, so these cannot be fresh imports). Each is a
// duplicate of a real-id row that exists or re-imports on the next sync.
//
// Safety:
//   - every target is verified UNLINKED (transfer_id null) at execution
//     time — deleting a LINKED row cascades to its partner (the root cause
//     of tonight's data loss); deleting unlinked rows cannot cascade.
//   - every target's imported_id must match the expected old-scheme ordinal
//     exactly; any mismatch aborts the whole run.
//   - full row JSON undo-logged before deletion.
//
// MUST run BEFORE the next sync: if these rows are still present when the
// linking pass runs, real debits get linked to these doomed duplicates and
// deleting them later would cascade again.
//
// Usage:
//   node scripts/cleanup-resurrected-ordinals.mjs           (dry run)
//   node scripts/cleanup-resurrected-ordinals.mjs --apply   (deletes + undo log)
import { writeFileSync } from "node:fs"
import { loadActualApi, loadEnv, initActual } from "./reconcile-lib.mjs"

const apply = process.argv.includes("--apply")

const TARGETS = [
  // BNZ Savings resurrected credits
  { id: "52892a1e-8a82-409d-ac59-495438bc690a", imported_id: "2026062910000-1" },
  { id: "4fb57f46-f3e8-4d27-b348-81fd78610469", imported_id: "202606295000-1" },
  { id: "74c27177-65d8-449e-bbb0-767823554c56", imported_id: "2026070610000-1" },
  { id: "a08fd9b6-1478-472f-b2d1-9986974f1241", imported_id: "202607065000-1" },
  { id: "3d337345-8a55-4325-8851-9d75e48f4d1c", imported_id: "2026071310000-1" },
  { id: "a43b9048-2c3f-4b18-b20f-c857b061632b", imported_id: "202607135000-1" },
  // ASB Checking resurrected debits
  { id: "d5eee29c", imported_id: "20260629-10000-3" },
  { id: "2f7f98f8", imported_id: "20260629-5000-3" },
  { id: "ed760681", imported_id: "20260706-10000-3" },
  { id: "f8e7a9ea", imported_id: "20260706-5000-3" },
  { id: "f75c17e9", imported_id: "20260713-10000-3" },
  { id: "54d8afa1", imported_id: "20260713-5000-3" },
]

loadEnv()
const api = await loadActualApi()
await initActual(api)
const q = async (b) => (await api.aqlQuery(b(api.q))).data

const undoLog = []
const toDelete = []
let abort = false

for (const target of TARGETS) {
  // ASB entries above only carry the 8-char id prefix — resolve via
  // imported_id (unique per account, verified) and cross-check the prefix.
  const rows = await q((qq) =>
    qq("transactions").filter({ imported_id: target.imported_id }).select(["*"]).options({ splits: "all" }),
  )
  if (rows.length !== 1) {
    console.log(`ABORT: imported_id ${target.imported_id} matched ${rows.length} rows (expected exactly 1)`)
    abort = true
    continue
  }
  const row = rows[0]
  if (!row.id.startsWith(target.id.slice(0, 8))) {
    console.log(`ABORT: imported_id ${target.imported_id} resolved to row ${row.id}, expected id starting ${target.id.slice(0, 8)}`)
    abort = true
    continue
  }
  if (row.transfer_id) {
    console.log(`ABORT: ${row.id} (${target.imported_id}) is LINKED (transfer_id=${row.transfer_id}) — deleting would cascade. Run unlink first.`)
    abort = true
    continue
  }
  console.log(`DELETE ${row.id.slice(0, 8)} ${row.date} ${(row.amount / 100).toFixed(2).padStart(9)} imp=${row.imported_id} account=${row.account.slice(0, 8)} "${row.notes ?? ""}"`)
  undoLog.push({ _reason: "resurrected ordinal duplicate", ...row })
  toDelete.push(row.id)
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
const logPath = `C:\\Users\\orlan\\akahu-sync\\logs\\cleanup-resurrected-${timestamp}-${apply ? "applied" : "dryrun"}.json`
writeFileSync(logPath, JSON.stringify(undoLog, null, 2), "utf8")

if (abort) {
  console.log("\nOne or more safety checks failed — NOTHING was deleted. Fix and re-run.")
  await api.shutdown()
  process.exit(1)
}

console.log(`\nrows to delete: ${toDelete.length}   log: ${logPath}`)
if (apply) {
  for (const id of toDelete) await api.deleteTransaction(id)
  console.log(`deleted ${toDelete.length} rows.`)
} else {
  console.log("\nDry run only — re-run with --apply to delete.")
}
await api.shutdown()

// One-off recovery (Phase 2, already applied 2026-07-17): clear the bogus
// imported_id / imported_payee that Actual's fuzzy matcher stamped onto the
// "3 FOR 10 Ensaymadas" split child of the Gold Ribbon receipt (2026-06-20,
// ASB Checking), absorbing a separate real transaction (Ekiben, 2026-06-24,
// -$10.00) into it. Stripping these fields reverts the row to a plain split
// line with no import history; the next sync then imports Ekiben as its own
// transaction under its real Akahu id, and — because ids are now stable
// (Phase 1) — will never re-collide with this row again.
//
// GOTCHA (cost real debugging time — leaving this here for next time):
// updateTransaction on a SPLIT CHILD is not a safe partial patch in
// @actual-app/api 26.7.0. Passing only { imported_id, imported_payee }
// silently zeroed `amount` to 0 and `category` to null on this row (visible
// as a SplitTransactionError on the parent). The fix was to pass the row's
// COMPLETE field set in one updateTransaction call, not just the changed
// fields. If you ever need to update a split child again, always fetch the
// full row first and pass every field back, changed or not.
import { loadActualApi, loadEnv, initActual } from "./reconcile-lib.mjs"

const ROW_ID = "ce2f361b-24e3-4e77-957a-596a5a286c33"

loadEnv()
const api = await loadActualApi()
await initActual(api)

const before = await api.aqlQuery(
  api.q("transactions").filter({ id: ROW_ID }).select(["*"]).options({ splits: "all" }),
)
console.log("BEFORE:", JSON.stringify(before.data[0], null, 2))

if (before.data[0]?.imported_id !== "20260624-1000-1") {
  console.log("Row does not match expected pre-recovery state (already recovered, or state has changed) — aborting without changes.")
  await api.shutdown()
  process.exit(1)
}

const row = before.data[0]
await api.updateTransaction(ROW_ID, {
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
  transfer_id: row.transfer_id,
  cleared: row.cleared,
  reconciled: row.reconciled,
  tombstone: row.tombstone,
  // The only actual change: drop the hijacked import identity.
  imported_id: null,
  imported_payee: null,
})

// NOTE: an immediate re-query in this SAME process can show stale
// (pre-update) data even though the write succeeded — observed twice
// (2026-07-17). Verify with a separate script invocation, not this one.
console.log("Update sent. Verify with a fresh, separate script run — an immediate re-query here can show stale data.")

await api.shutdown()

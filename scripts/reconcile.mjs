// Permanent reconciliation tool: compares Actual Budget balances against
// Akahu for every synced account, and checks ledger invariants that guard
// against the failure modes found in the 2026-07 investigation:
//   (a) no split child carries an imported_id (Actual's fuzzy matcher
//       absorbing a real bank transaction into a manual split — see the
//       "Ekiben" incident)
//   (b) no duplicate imported_id within an account (unstable ordinal ids)
//   (c) every posted Akahu transaction in the sync window is matched by
//       exactly one Actual row (amount + NZ-date, ±2 days)
//   (d) every transfer-linked row has a valid counterpart with the same
//       transfer_id in a different account
//
// Usage: node scripts/reconcile.mjs [--window-days=35] [--json]
import {
  ACCOUNTS,
  akahuAccount,
  akahuTransactions,
  cents,
  dollars,
  initActual,
  loadActualApi,
  loadEnv,
  toNZDate,
  dayNum,
} from "./reconcile-lib.mjs"

const args = process.argv.slice(2)
const windowDays = Number(
  args.find((a) => a.startsWith("--window-days="))?.split("=")[1] ?? 35,
)
const asJson = args.includes("--json")

loadEnv()
const api = await loadActualApi()
await initActual(api)

const q = async (build) => (await api.aqlQuery(build(api.q))).data

const startIso = new Date(Date.now() - windowDays * 86400000).toISOString()

const report = { accounts: [], invariants: {}, ok: true }

for (const acct of ACCOUNTS) {
  const akAccount = await akahuAccount(acct.akahuId)
  const akTxns = await akahuTransactions(acct.akahuId, startIso)

  const balanceRow = await api.aqlQuery(
    api.q("transactions")
      .filter({ account: acct.actualId })
      .calculate({ $sum: "$amount" }),
  )
  const actualBalance = (balanceRow.data ?? 0) / 100

  const unclearedRow = await api.aqlQuery(
    api.q("transactions")
      .filter({ account: acct.actualId, cleared: false })
      .calculate({ $sum: "$amount" }),
  )
  const uncleared = (unclearedRow.data ?? 0) / 100

  const baselineValue = akAccount.balance?.[acct.baseline]
  const diff =
    baselineValue == null ? null : +(actualBalance - baselineValue).toFixed(2)

  let pass
  if (diff === null) pass = false
  else if (acct.diffShouldEqualUncleared)
    pass = Math.abs(diff - uncleared) < 0.01
  else pass = Math.abs(diff) < 0.01

  report.accounts.push({
    name: acct.name,
    baseline: acct.baseline,
    actualBalance,
    akahuBaseline: baselineValue,
    diff,
    uncleared,
    pass,
    akahuTxnCount: akTxns.length,
    lastRefreshed: akAccount.refreshed?.transactions,
  })
  if (!pass) report.ok = false
}

// ---- invariant checks across all synced accounts ----
const actualIds = ACCOUNTS.map((a) => a.actualId)
const allRows = await q((qq) =>
  qq("transactions")
    .filter({ $or: actualIds.map((a) => ({ account: a })) })
    .select([
      "id",
      "date",
      "amount",
      "account",
      "imported_id",
      "transfer_id",
      "is_parent",
      "is_child",
      "payee.name",
      "payee.transfer_acct",
    ])
    .options({ splits: "all" })
    .limit(20000),
)

// (a) split children must never carry an imported_id
const hijackedChildren = allRows.filter((t) => t.is_child && t.imported_id)
report.invariants.hijackedChildren = {
  pass: hijackedChildren.length === 0,
  count: hijackedChildren.length,
  rows: hijackedChildren.map((t) => ({
    id: t.id,
    date: t.date,
    amount: t.amount / 100,
    imported_id: t.imported_id,
  })),
}

// (b) no duplicate imported_id within an account
const seen = new Map()
for (const t of allRows) {
  if (!t.imported_id) continue
  const key = `${t.account}:${t.imported_id}`
  seen.set(key, (seen.get(key) ?? []).concat(t.id))
}
const duplicateImportedIds = [...seen.entries()].filter(([, ids]) => ids.length > 1)
report.invariants.duplicateImportedIds = {
  pass: duplicateImportedIds.length === 0,
  count: duplicateImportedIds.length,
  rows: duplicateImportedIds.map(([key, ids]) => ({ key, ids })),
}

// (c) every posted Akahu transaction in-window matches exactly one Actual row
// (amount + NZ-date within +/-2 days). This is a best-effort match until
// Phase 1 lands stable ids; afterwards it should be an exact externalId match.
const missingFromActual = []
for (const acct of ACCOUNTS) {
  const akTxns = await akahuTransactions(acct.akahuId, startIso)
  // Match against parents and plain rows (the whole imported transaction),
  // not split children — a child carrying the real imported_id is exactly
  // the "hijacked" failure mode invariant (a) catches, and letting it
  // satisfy this match too would mask the transaction as present.
  const rowsForAcct = allRows.filter((t) => t.account === acct.actualId && !t.is_child)
  const usedActual = new Set()
  for (const akT of akTxns) {
    const akDate = toNZDate(akT.date)
    const akCents = Math.round(akT.amount * 100)
    const match = rowsForAcct.find(
      (t) =>
        !usedActual.has(t.id) &&
        t.amount === akCents &&
        Math.abs(dayNum(t.date) - dayNum(akDate)) <= 2,
    )
    if (match) usedActual.add(match.id)
    else
      missingFromActual.push({
        account: acct.name,
        date: akDate,
        amount: akT.amount,
        description: akT.description,
        akahuId: akT._id,
      })
  }
}
report.invariants.missingFromActual = {
  pass: missingFromActual.length === 0,
  count: missingFromActual.length,
  rows: missingFromActual,
}

// (d) every transfer-linked row must have a valid counterpart. Actual's
// transfer_id is NOT a shared token on both legs — it is the *other* row's
// own id (see ImportTransactionEntity: "the id of the corresponding
// transaction in the other account"). A working pair is mutual: row A's
// transfer_id === row B.id AND row B's transfer_id === row A.id, in two
// different accounts, with opposite-sign amounts.
//
// Counterparts of synced-account transfers can live in unsynced manual
// accounts (e.g. ASB Checking -> Rabo), so counterpart lookup spans the
// whole budget, not just the synced accounts.
const everyRow = await q((qq) =>
  qq("transactions")
    .select(["id", "account", "amount", "transfer_id"])
    .options({ splits: "all" })
    .limit(50000),
)
const byId = new Map(everyRow.map((t) => [t.id, t]))
const brokenTransfers = []
for (const t of allRows) {
  if (!t.transfer_id) continue
  const mate = byId.get(t.transfer_id)
  if (!mate) {
    brokenTransfers.push({ id: t.id, account: t.account, reason: "counterpart id not found", transfer_id: t.transfer_id })
    continue
  }
  if (mate.account === t.account) {
    brokenTransfers.push({ id: t.id, account: t.account, reason: "counterpart in same account", mate: mate.id })
    continue
  }
  if (mate.transfer_id !== t.id) {
    brokenTransfers.push({ id: t.id, account: t.account, reason: "counterpart transfer_id does not point back", mate: mate.id, mateTransferId: mate.transfer_id })
    continue
  }
  if (mate.amount !== -t.amount) {
    brokenTransfers.push({ id: t.id, account: t.account, reason: "amounts not opposite", amount: t.amount / 100, mateAmount: mate.amount / 100 })
  }
}
report.invariants.brokenTransfers = {
  pass: brokenTransfers.length === 0,
  count: brokenTransfers.length,
  rows: brokenTransfers,
}

for (const inv of Object.values(report.invariants)) {
  if (!inv.pass) report.ok = false
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`\n=== RECONCILIATION (window: ${windowDays} days) ===`)
  for (const a of report.accounts) {
    console.log(
      `\n${a.name}  [baseline: ${a.baseline}]  ${a.pass ? "PASS" : "FAIL"}`,
    )
    console.log(`  Actual balance : ${dollars(cents(a.actualBalance))}`)
    console.log(`  Akahu ${a.baseline.padEnd(9)}: ${a.akahuBaseline?.toFixed(2) ?? "n/a"}`)
    console.log(`  diff           : ${a.diff?.toFixed(2) ?? "n/a"}`)
    console.log(`  uncleared      : ${a.uncleared.toFixed(2)}`)
    console.log(`  akahu refreshed: ${a.lastRefreshed}`)
  }

  console.log(`\n=== INVARIANTS ===`)
  for (const [key, inv] of Object.entries(report.invariants)) {
    console.log(`  ${key.padEnd(20)} ${inv.pass ? "PASS" : `FAIL (${inv.count})`}`)
    if (!inv.pass) {
      for (const r of inv.rows.slice(0, 10)) console.log(`    ${JSON.stringify(r)}`)
      if (inv.rows.length > 10) console.log(`    ... and ${inv.rows.length - 10} more`)
    }
  }

  console.log(`\n=== OVERALL: ${report.ok ? "PASS" : "FAIL"} ===\n`)
}

await api.shutdown()
process.exit(report.ok ? 0 : 1)

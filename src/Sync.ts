/**
 * @since 1.0.0
 */
import {
  Array,
  BigDecimal,
  DateTime,
  Duration,
  Effect,
  FiberSet,
  pipe,
} from "effect"
import {
  type AccountTransaction,
  AccountTransactionOrder,
  Bank,
} from "./Bank.ts"
import { Actual } from "./Actual.ts"

const bigDecimal100 = BigDecimal.fromNumberUnsafe(100)
const amountToInt = (amount: BigDecimal.BigDecimal) =>
  amount.pipe(BigDecimal.multiply(bigDecimal100), BigDecimal.toNumberUnsafe)

export const runCollect = Effect.fnUntraced(function* (options: {
  readonly accounts: ReadonlyArray<{
    readonly bankAccountId: string
    readonly actualAccountId: string
  }>
  readonly categorize: boolean
  readonly categoryMapping?: ReadonlyArray<{
    readonly bankCategory: string
    readonly actualCategory: string
  }>
  readonly categories: ReadonlyArray<{
    readonly id: string
    readonly name: string
  }>
  readonly payees: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly transfer_acct?: string
  }>
  readonly syncDuration: Duration.Duration
  /**
   * Routes a recurring transfer (standing order, direct debit) to a
   * destination account by matching a stable token against the
   * transaction's `particulars` (falling back to `notes`) — bank
   * description text alone is too fragile (it embeds a per-transaction
   * reference that changes every time). If the destination is one of
   * `accounts` (synced both sides), the transaction is left unresolved
   * here and instead queued as a link candidate for `run` to pair with its
   * real, independently-Akahu-fed counterpart after both sides are
   * imported — setting a transfer payee at collect time would make Actual
   * auto-create a THIRD, redundant row. If the destination is not synced
   * (e.g. a manual account with no Akahu feed of its own), there's no
   * counterpart to pair with, so the transfer payee is resolved directly,
   * same as the existing `transfer` (meta.other_account) path below.
   */
  readonly transferMatch?: ReadonlyArray<{
    readonly token: string
    readonly actualAccountId: string
  }>
}) {
  const bank = yield* Bank
  const importId = makeImportId()

  const categoryId = (transaction: AccountTransaction) => {
    const categoryName =
      options.categoryMapping?.find(
        (mapping) => mapping.bankCategory === transaction.category,
      )?.actualCategory ?? transaction.category
    const category = options.categories.find(
      (c) => c.name.toLowerCase() === categoryName?.toLowerCase(),
    )
    return category ? category.id : undefined
  }

  const transferAccountId = (transaction: AccountTransaction) => {
    const transferToAccount = options.accounts.find(
      ({ bankAccountId }) => bankAccountId === transaction.transfer,
    )?.actualAccountId
    return options.payees.find((it) => it.transfer_acct === transferToAccount)
      ?.id
  }

  const payeeForAccount = (actualAccountId: string) =>
    options.payees.find((it) => it.transfer_acct === actualAccountId)?.id

  const matchTransferConfig = (transaction: AccountTransaction) => {
    const text = (
      transaction.particulars ??
      transaction.notes ??
      ""
    ).toLowerCase()
    if (!text) return undefined
    return options.transferMatch?.find((m) =>
      text.includes(m.token.toLowerCase()),
    )
  }

  const now = yield* DateTime.now
  const since = DateTime.subtractDuration(now, options.syncDuration)

  // Pass 1: collect raw AccountTransactions per account
  const rawPerAccount = yield* Effect.forEach(
    options.accounts,
    Effect.fnUntraced(function* ({ bankAccountId, actualAccountId }) {
      const transactions = yield* bank.exportAccount(bankAccountId, { since })
      return { bankAccountId, actualAccountId, transactions }
    }),
  )

  // Cross-bank transfer matching: find TRANSFER transactions with no resolved
  // transfer field (meta.other_account didn't resolve), match pairs across
  // accounts by opposite amount + date within 2 days. Each side is queued as
  // a link candidate targeting the OTHER side's account — resolved for real
  // after both import, by the same post-import linking pass `transferMatch`
  // uses (see LinkCandidate below). This used to assign both sides a shared
  // random UUID directly as transfer_id at collect time, which doesn't match
  // Actual's real semantics (transfer_id is the OTHER row's own server-
  // assigned id, unknown until insert) — confirmed broken in production on
  // 2026-07-17 (a dangling transfer_id pointing at a uuid that was never any
  // row's real id). Key by transaction object reference to avoid
  // double-incrementing the stateful importId counter.
  type PendingTransfer = {
    transaction: AccountTransaction
    amount: BigDecimal.BigDecimal
    actualAccountId: string
    date: string
  }
  const pending: Array<PendingTransfer> = []
  for (const { actualAccountId, transactions } of rawPerAccount) {
    for (const t of transactions) {
      if (t.type !== "TRANSFER" || t.transfer !== undefined) continue
      pending.push({
        transaction: t,
        amount: t.amount,
        date: DateTime.formatIsoDate(t.dateTime),
        actualAccountId,
      })
    }
  }

  const crossBankLinkTarget = new Map<AccountTransaction, string>()
  const matched = new Set<AccountTransaction>()
  for (let i = 0; i < pending.length; i++) {
    const a = pending[i]!
    if (matched.has(a.transaction)) continue
    for (let j = i + 1; j < pending.length; j++) {
      const b = pending[j]!
      if (matched.has(b.transaction)) continue
      if (a.actualAccountId === b.actualAccountId) continue
      if (!BigDecimal.equals(a.amount, BigDecimal.negate(b.amount))) continue
      if (daysBetween(a.date, b.date) > 2) continue
      crossBankLinkTarget.set(a.transaction, b.actualAccountId)
      crossBankLinkTarget.set(b.transaction, a.actualAccountId)
      matched.add(a.transaction)
      matched.add(b.transaction)
      break
    }
  }

  const syncedAccountIds = new Set(
    options.accounts.map((a) => a.actualAccountId),
  )

  // Pass 2: convert to ImportTransaction, attaching transfer_id where matched
  return rawPerAccount.map(
    ({ bankAccountId, actualAccountId, transactions }) => {
      const ids: Array<string> = []
      const linkCandidates: Array<LinkCandidate> = []
      const forImport = pipe(
        transactions,
        // oxlint-disable-next-line unicorn/no-array-sort
        Array.sort(AccountTransactionOrder),
        // oxlint-disable-next-line oxc/no-map-spread
        Array.map((transaction): ImportTransaction => {
          const imported_id = importId(bankAccountId, transaction)
          const category = options.categorize && categoryId(transaction)
          const date = DateTime.formatIsoDate(transaction.dateTime)
          const amount = amountToInt(transaction.amount)
          ids.push(imported_id)

          let transferPayee =
            transaction.transfer && transferAccountId(transaction)

          const crossBankTarget = crossBankLinkTarget.get(transaction)
          if (crossBankTarget) {
            linkCandidates.push({
              imported_id,
              targetAccountId: crossBankTarget,
              amount,
              date,
            })
          } else if (!transferPayee && transaction.transfer === undefined) {
            const config = matchTransferConfig(transaction)
            if (config && syncedAccountIds.has(config.actualAccountId)) {
              linkCandidates.push({
                imported_id,
                targetAccountId: config.actualAccountId,
                amount,
                date,
              })
            } else if (config) {
              transferPayee = payeeForAccount(config.actualAccountId)
            }
          }

          return {
            account: actualAccountId,
            imported_id,
            date,
            ...(transferPayee
              ? { payee: transferPayee }
              : { payee_name: transaction.payee }),
            amount,
            notes: transaction.notes,
            cleared: transaction.cleared,
            forceAddTransaction: true,
            ...(category ? { category } : undefined),
          }
        }),
      )
      return { transactions: forImport, ids, actualAccountId, linkCandidates }
    },
  )
})

type LinkCandidate = {
  readonly imported_id: string
  readonly targetAccountId: string
  readonly amount: number
  readonly date: string
}

type ImportTransaction =
  | {
      category?: string | undefined
      amount: number
      notes: string | undefined
      cleared: boolean | undefined
      payee: string
      account: string
      imported_id: string
      date: string
      // Disables Actual's server-side fuzzy transaction matching for this
      // row (see reconcileTransactions in Actual's sync.ts — its final
      // matching pass ignores payee entirely and absorbs a real bank
      // transaction into the FIRST unmatched same-amount/nearby-date row it
      // finds, including manual split children). That absorbed a real
      // transaction into a receipt-split child twice in production
      // (2026-07 "Ekiben" incident) — this sync already dedupes by
      // imported_id via findImported before ever calling importTransactions,
      // so the fuzzy match can only ever do harm here, never good.
      forceAddTransaction: true
    }
  | {
      category?: string | undefined
      amount: number
      notes: string | undefined
      cleared: boolean | undefined
      payee_name: string
      account: string
      imported_id: string
      date: string
      forceAddTransaction: true
    }

export const run = Effect.fnUntraced(function* (options: {
  readonly accounts: ReadonlyArray<{
    readonly bankAccountId: string
    readonly actualAccountId: string
  }>
  readonly categorize: boolean
  readonly categoryMapping?: ReadonlyArray<{
    readonly bankCategory: string
    readonly actualCategory: string
  }>
  readonly syncDuration: Duration.Duration
  readonly clearedOnly: boolean
  readonly transferMatch?: ReadonlyArray<{
    readonly token: string
    readonly actualAccountId: string
  }>
  /** Log every mutating action instead of performing it. */
  readonly dryRun?: boolean
}) {
  const actual = yield* Actual
  const fibers = yield* FiberSet.make()
  const categories = yield* actual.use((_) => _.getCategories())
  const payees = yield* actual.use((_) => _.getPayees())

  // Wraps a mutating Actual call so `--dry-run` can log intent instead of
  // acting. Centralised here (rather than an `if` at each call site) after
  // the 2026-07-17 incident where a partial-field updateTransaction call
  // silently zeroed unrelated fields on a split child — every mutation in
  // this file now goes through one narrow, auditable seam.
  const maybeRun = <A, E, R>(
    description: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<void, E, R> =>
    options.dryRun
      ? Effect.log(`[dry run] ${description}`)
      : Effect.asVoid(effect)

  const payeeForAccount = (actualAccountId: string) =>
    payees.find((p) => p.transfer_acct === actualAccountId)?.id

  const results = yield* runCollect({
    ...options,
    categories,
    payees,
  })

  const newTransactions = new Map<string, Array<ImportTransaction>>()
  const allLinkCandidates: Array<
    LinkCandidate & { readonly actualAccountId: string }
  > = []

  for (const {
    transactions,
    ids,
    actualAccountId,
    linkCandidates,
  } of results) {
    for (const c of linkCandidates)
      allLinkCandidates.push({ ...c, actualAccountId })

    const alreadyImported = yield* actual.findImported(ids, actualAccountId)

    // Pending Akahu transactions import under a "pending-..." ordinal id
    // (see PENDING_ID_PREFIX). When the same transaction later posts, it
    // arrives here with a real, different externalId, so it won't be found
    // in `alreadyImported` above. Without this pass it would be inserted as
    // a duplicate instead of reconciling the pending row that's already
    // sitting in the ledger. `claimed` tracks candidates already matched to
    // a posted transaction earlier in this same loop.
    const pendingPool = (yield* actual.findPendingCandidates(
      actualAccountId,
    )).map((row) => Object.assign({ claimed: false }, row))

    for (const transaction of transactions) {
      if (options.clearedOnly && !transaction.cleared) {
        continue
      }

      const existing = alreadyImported.get(transaction.imported_id)
      if (!existing) {
        const pendingCandidate =
          transaction.cleared &&
          !transaction.imported_id.startsWith(PENDING_ID_PREFIX)
            ? pendingPool.find(
                (candidate) =>
                  !candidate.claimed &&
                  candidate.amount === transaction.amount &&
                  daysBetween(candidate.date, transaction.date) <= 3,
              )
            : undefined

        if (pendingCandidate) {
          pendingCandidate.claimed = true
          yield* FiberSet.run(
            fibers,
            maybeRun(
              `reconcile pending row ${pendingCandidate.id} -> ${transaction.imported_id}`,
              actual.use((_) =>
                _.updateTransaction(pendingCandidate.id, {
                  imported_id: transaction.imported_id,
                  cleared: true,
                  amount: transaction.amount,
                  notes: transaction.notes,
                  ...(transaction.category
                    ? { category: transaction.category }
                    : {}),
                }),
              ),
            ),
          )
        } else {
          let arr = newTransactions.get(actualAccountId)
          if (!arr) {
            arr = []
            newTransactions.set(actualAccountId, arr)
          }
          arr.push(transaction)
        }
        continue
      }

      if (transaction.cleared && !existing.cleared) {
        yield* FiberSet.run(
          fibers,
          maybeRun(
            `mark cleared ${existing.id}`,
            actual.use((_) =>
              _.updateTransaction(existing.id, {
                cleared: true,
                amount: transaction.amount,
                ...(!existing.category && transaction.category
                  ? { category: transaction.category }
                  : {}),
              }),
            ),
          ),
        )

        const existingPayee = payees.find((p) => p.id === existing.payee)
        if (
          existingPayee &&
          "payee_name" in transaction &&
          transaction.payee_name !== existing.imported_payee &&
          existingPayee.name === existing.imported_payee
        ) {
          yield* FiberSet.run(
            fibers,
            maybeRun(
              `rename payee ${existingPayee.id} -> "${transaction.payee_name}"`,
              actual.use((_) =>
                _.updatePayee(existingPayee.id, {
                  name: transaction.payee_name,
                }),
              ),
            ),
          )
        }
      }

      if ("payee" in transaction && existing.payee !== transaction.payee) {
        yield* FiberSet.run(
          fibers,
          maybeRun(
            `set payee ${existing.id} -> ${transaction.payee}`,
            actual.use((_) =>
              _.updateTransaction(existing.id, {
                payee: transaction.payee,
              }),
            ),
          ),
        )
      }
    }
  }
  yield* FiberSet.awaitEmpty(fibers)

  for (const [actualAccountId, transactions] of newTransactions) {
    yield* FiberSet.run(
      fibers,
      maybeRun(
        `import ${transactions.length} transaction(s) into ${actualAccountId}`,
        actual.use((_) => _.importTransactions(actualAccountId, transactions)),
      ),
    )
  }
  yield* FiberSet.awaitEmpty(fibers)

  // Phase 3: link cross-account transfers. Both sides of a `transferMatch`
  // pair between two SYNCED accounts are independently fed by Akahu and
  // were just imported above as plain transactions (see runCollect) — this
  // pairs them via a mutual transfer_id, matching Actual's real semantics
  // (transfer_id is the OTHER row's own id, verified against this budget's
  // working transfer pairs via reconcile.mjs's brokenTransfers invariant —
  // NOT a shared token, which is what the older same-run crossBankTransferIds
  // path above uses and is why that mechanism is left untouched rather than
  // reused here). Doing this as a separate, post-import pass — instead of
  // setting a transfer payee at collect time — is what avoids Actual's
  // rule-engine auto-creating a third, redundant counterpart row.
  // Rows already used in a link THIS RUN. The DB queries below can't see a
  // link until its updateTransaction lands, so without this in-memory guard
  // two candidates processed back-to-back could claim the same mate —
  // observed in production 2026-07-17 (two ASB debits from different weeks
  // both linked to the same BNZ credit; last write won, leaving one row's
  // transfer_id dangling). Same reason the link updates run synchronously
  // (yield* directly) instead of being deferred to the fiber pool.
  const claimedIds = new Set<string>()

  for (const candidate of allLinkCandidates) {
    // Matching is read-only, so it always runs (even in dry-run) — this is
    // what makes --dry-run actually show what WOULD be linked, not just a
    // count. Note: if the candidate's own row was itself a brand-new import
    // in this same dry run, it was never written, so it won't be found here
    // yet — that limitation is expected and logged below.
    const ourRows = yield* actual.findImported(
      [candidate.imported_id],
      candidate.actualAccountId,
    )
    const ourRow = ourRows.get(candidate.imported_id)
    if (!ourRow) {
      if (options.dryRun) {
        yield* Effect.log(
          `[dry run] link candidate ${candidate.imported_id} (${candidate.actualAccountId}) not found — likely not yet imported in this dry run`,
        )
      }
      continue
    }
    if (ourRow.transfer_id || claimedIds.has(ourRow.id)) {
      // Already linked — either by a previous candidate in this run (both
      // sides of a transfer are candidates targeting each other, so the
      // second one finds the work already done), or by an Actual rule that
      // fired on import before this pass ran.
      continue
    }

    const mate = yield* actual.findUnlinkedTransferCandidate(
      candidate.targetAccountId,
      -candidate.amount,
      candidate.date,
    )
    if (!mate || claimedIds.has(mate.id)) {
      if (options.dryRun) {
        yield* Effect.log(
          `[dry run] link candidate ${ourRow.id} (${candidate.actualAccountId}, ${candidate.date}, ${candidate.amount}) has no unclaimed counterpart yet in ${candidate.targetAccountId}`,
        )
      }
      continue
    }

    claimedIds.add(ourRow.id)
    claimedIds.add(mate.id)
    yield* maybeRun(
      `link ${ourRow.id} (${candidate.actualAccountId}) <-> ${mate.id} (${candidate.targetAccountId}), amount ${candidate.amount}`,
      actual.use((_) =>
        _.updateTransaction(ourRow.id, {
          ...fullTransactionFields(ourRow),
          transfer_id: mate.id,
          payee: payeeForAccount(candidate.targetAccountId) ?? ourRow.payee,
        }),
      ),
    )
    yield* maybeRun(
      `link ${mate.id} (${candidate.targetAccountId}) <-> ${ourRow.id} (${candidate.actualAccountId})`,
      actual.use((_) =>
        _.updateTransaction(mate.id, {
          ...fullTransactionFields(mate),
          transfer_id: ourRow.id,
          payee: payeeForAccount(candidate.actualAccountId) ?? mate.payee,
        }),
      ),
    )
  }
}, Effect.scoped)

// Full field payload for a transaction update — see the maybeRun comment
// above: a partial updateTransaction call on this API is not guaranteed to
// leave other fields alone (observed zeroing amount/category on a split
// child in the 2026-07-17 incident). Always pass the complete row back.
const fullTransactionFields = (row: {
  readonly is_parent?: boolean
  readonly is_child?: boolean
  readonly parent_id?: string
  readonly category?: string
  readonly amount: number
  readonly payee?: string | null
  readonly notes?: string
  readonly date: string
  readonly imported_id?: string
  readonly imported_payee?: string
  readonly starting_balance_flag?: boolean
  readonly cleared?: boolean
  readonly reconciled?: boolean
  readonly tombstone?: boolean
}) => ({
  is_parent: row.is_parent,
  is_child: row.is_child,
  parent_id: row.parent_id,
  category: row.category,
  amount: row.amount,
  payee: row.payee,
  notes: row.notes,
  date: row.date,
  imported_id: row.imported_id,
  imported_payee: row.imported_payee,
  starting_balance_flag: row.starting_balance_flag,
  cleared: row.cleared,
  reconciled: row.reconciled,
  tombstone: row.tombstone,
})

const daysBetween = (a: string, b: string): number =>
  Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86400000

// Ordinal ids (date+amount+counter) are only ever assigned to transactions
// with no stable externalId — in practice this means Akahu's pending
// transactions, which carry no `_id`. Prefixing with "pending-" lets the
// reconciliation pass in `run` recognize and retire these rows once the
// same transaction posts with a real externalId, instead of duplicating
// them. The prefix also makes it structurally impossible for an ordinal id
// to collide with an Akahu `trans_...` externalId.
export const PENDING_ID_PREFIX = "pending-"

const makeImportId = () => {
  const counters = new Map<string, number>()
  return (accountId: string, self: AccountTransaction) => {
    if (self.externalId !== undefined) return self.externalId
    const dateParts = DateTime.toParts(self.dateTime)
    const dateString = `${dateParts.year.toString().padStart(4, "0")}${dateParts.month.toString().padStart(2, "0")}${dateParts.day.toString().padStart(2, "0")}`
    const amountInt = amountToInt(self.amount)
    const prefix = `${dateString}${amountInt}`
    const key = `${accountId}:${prefix}`
    const count = counters.has(key) ? counters.get(key)! + 1 : 1
    counters.set(key, count)
    const ordinal = `${prefix}-${count}`
    return self.cleared === false ? `${PENDING_ID_PREFIX}${ordinal}` : ordinal
  }
}

export const testCategories = [
  { id: "1", name: "Transport" },
  { id: "2", name: "Groceries" },
  { id: "3", name: "Internet" },
  { id: "4", name: "Rent" },
]

export const testPayees = [
  { id: "1", name: "Acme" },
  { id: "2", name: "Bobs" },
  { id: "3", name: "Cafe" },
  { id: "4", name: "Deli" },
  { id: "5", name: "Verizon" },
  { id: "6", name: "Checking", transfer_acct: "actual-checking" },
  { id: "7", name: "Savings", transfer_acct: "actual-savings" },
]

export const runTest = Effect.fnUntraced(function* (options: {
  readonly categorize: boolean
  readonly categoryMapping?: ReadonlyArray<{
    readonly bankCategory: string
    readonly actualCategory: string
  }>
}) {
  const results = yield* runCollect({
    ...options,
    accounts: [
      {
        bankAccountId: "checking",
        actualAccountId: "actual-checking",
      },
      {
        bankAccountId: "savings",
        actualAccountId: "actual-savings",
      },
    ],
    categories: testCategories,
    payees: testPayees,
    syncDuration: Duration.days(30),
  })
  return results.flatMap((account) =>
    account.transactions.map((transaction) => ({
      ...transaction,
      account: account.actualAccountId,
    })),
  )
})

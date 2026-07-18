import { BigDecimal, DateTime, Duration, Effect, Layer, Stream } from "effect"
import {
  AccountId,
  Akahu,
  AkahuLayer,
  ConnectionId,
  PendingTransaction,
  Transaction,
  UserId,
} from "./Akahu.ts"
import { assert, it } from "@effect/vitest"
import { runCollect, runTest, testCategories, testPayees } from "../Sync.ts"

const AkahuTest = Layer.succeed(Akahu)(
  Akahu.of({
    lastRefreshed: DateTime.now,
    refresh: Effect.succeed({ success: true }),
    accounts: Stream.empty,
    transactions: (accountId: string) =>
      accountId === "checking"
        ? Stream.make(
            new PendingTransaction({
              _user: UserId.makeUnsafe("1"),
              _account: AccountId.makeUnsafe("1"),
              _connection: ConnectionId.makeUnsafe("1"),
              date: DateTime.makeUnsafe("2021-01-01T00:00:00Z"),
              description: "Pending transaction",
              amount: BigDecimal.fromStringUnsafe("100.50"),
            }),
            new Transaction({
              _id: "1",
              _user: UserId.makeUnsafe("1"),
              _account: AccountId.makeUnsafe("1"),
              _connection: ConnectionId.makeUnsafe("1"),
              date: DateTime.makeUnsafe("2021-01-02T00:00:00Z"),
              description: "Transaction",
              amount: BigDecimal.fromStringUnsafe("200.50"),
            }),
          )
        : Stream.empty,
  }),
)

// Cross-bank transfer: checking sends $500, savings receives $500, no meta.other_account
const AkahuCrossBankTest = Layer.succeed(Akahu)(
  Akahu.of({
    lastRefreshed: DateTime.now,
    refresh: Effect.succeed({ success: true }),
    accounts: Stream.empty,
    transactions: (accountId: string) =>
      accountId === "checking"
        ? Stream.make(
            new Transaction({
              _id: "xfer-out",
              _user: UserId.makeUnsafe("1"),
              _account: AccountId.makeUnsafe("checking"),
              _connection: ConnectionId.makeUnsafe("1"),
              date: DateTime.makeUnsafe("2021-03-01T00:00:00Z"),
              description: "Transfer to savings",
              amount: BigDecimal.fromStringUnsafe("-500"),
              type: "TRANSFER",
            }),
          )
        : accountId === "savings"
          ? Stream.make(
              new Transaction({
                _id: "xfer-in",
                _user: UserId.makeUnsafe("1"),
                _account: AccountId.makeUnsafe("savings"),
                _connection: ConnectionId.makeUnsafe("1"),
                date: DateTime.makeUnsafe("2021-03-01T00:00:00Z"),
                description: "Transfer from checking",
                amount: BigDecimal.fromStringUnsafe("500"),
                type: "TRANSFER",
              }),
            )
          : Stream.empty,
  }),
)

const BankTest = AkahuLayer.pipe(Layer.provide(AkahuTest))
const BankCrossBankTest = AkahuLayer.pipe(Layer.provide(AkahuCrossBankTest))

it.layer(BankTest)("Akahu", (it) => {
  it.effect("Sync", () =>
    Effect.gen(function* () {
      const results = yield* runTest({ categorize: false })
      assert.deepStrictEqual(results, [
        {
          imported_id: "pending-2021010110050-1",
          date: "2021-01-01",
          payee_name: "Pending transaction",
          amount: 10050,
          notes: undefined,
          cleared: false,
          account: "actual-checking",
          forceAddTransaction: true,
        },
        {
          imported_id: "1",
          date: "2021-01-02",
          payee_name: "Transaction",
          amount: 20050,
          notes: "Transaction",
          cleared: true,
          account: "actual-checking",
          forceAddTransaction: true,
        },
      ])
    }),
  )
})

it.layer(BankCrossBankTest)("Akahu cross-bank transfer", (it) => {
  // transfer_id can't be assigned at collect time — it must be the OTHER
  // row's real, server-assigned id, which doesn't exist until both sides
  // are imported (see the 2026-07-17 incident: the old shared-UUID
  // approach produced a transfer_id that matched neither row's real id).
  // So runCollect only queues each side as a link candidate targeting the
  // other's account; Sync.run's post-import pass does the actual linking.
  it.effect(
    "queues both sides as link candidates targeting each other's account, without setting transfer_id at collect time",
    () =>
      Effect.gen(function* () {
        const results = yield* runCollect({
          accounts: [
            { bankAccountId: "checking", actualAccountId: "actual-checking" },
            { bankAccountId: "savings", actualAccountId: "actual-savings" },
          ],
          syncDuration: Duration.days(30),
          categorize: false,
          categories: testCategories,
          payees: testPayees,
        })

        const checking = results.find(
          (r) => r.actualAccountId === "actual-checking",
        )!
        const savings = results.find(
          (r) => r.actualAccountId === "actual-savings",
        )!

        assert.isFalse(
          "transfer_id" in checking.transactions[0],
          "transfer_id must not be set at collect time",
        )
        assert.isFalse("transfer_id" in savings.transactions[0])

        assert.equal(checking.linkCandidates.length, 1)
        assert.equal(
          checking.linkCandidates[0].targetAccountId,
          "actual-savings",
        )
        assert.equal(savings.linkCandidates.length, 1)
        assert.equal(
          savings.linkCandidates[0].targetAccountId,
          "actual-checking",
        )
      }),
  )
})

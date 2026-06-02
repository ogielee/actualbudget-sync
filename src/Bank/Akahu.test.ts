import { BigDecimal, DateTime, Effect, Layer, Stream } from "effect"
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
import { runTest } from "../Sync.ts"

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
          imported_id: "2021010110050-1",
          date: "2021-01-01",
          payee_name: "Pending transaction",
          amount: 10050,
          notes: undefined,
          cleared: false,
          account: "actual-checking",
        },
        {
          imported_id: "2021010220050-1",
          date: "2021-01-02",
          payee_name: "Transaction",
          amount: 20050,
          notes: "Transaction",
          cleared: true,
          account: "actual-checking",
        },
      ])
    }),
  )
})

it.layer(BankCrossBankTest)("Akahu cross-bank transfer", (it) => {
  it.effect("links both sides with a shared transfer_id", () =>
    Effect.gen(function* () {
      const results = yield* runTest({ categorize: false })
      const out = results.find((t) => t.account === "actual-checking")
      const inn = results.find((t) => t.account === "actual-savings")
      assert.ok(out, "outgoing transaction should exist")
      assert.ok(inn, "incoming transaction should exist")
      assert.ok(out.transfer_id, "outgoing should have transfer_id")
      assert.ok(inn.transfer_id, "incoming should have transfer_id")
      assert.strictEqual(
        out.transfer_id,
        inn.transfer_id,
        "both sides must share the same transfer_id",
      )
    }),
  )
})

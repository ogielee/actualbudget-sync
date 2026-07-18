import { BigDecimal, DateTime, Duration, Effect, Layer } from "effect"
import { assert, it } from "@effect/vitest"
import { Bank, type AccountTransaction } from "./Bank.ts"
import {
  PENDING_ID_PREFIX,
  runCollect,
  testCategories,
  testPayees,
} from "./Sync.ts"

const amount = (s: string) => BigDecimal.fromStringUnsafe(s)
const date = (s: string) => DateTime.makeUnsafe(s)

/** Minimal Bank fixture that returns exactly the transactions given. */
const bankLayer = (
  byAccount: Record<string, ReadonlyArray<AccountTransaction>>,
): Layer.Layer<Bank> =>
  Layer.succeed(Bank)(
    Bank.of({
      exportAccount: (accountId) => Effect.succeed(byAccount[accountId] ?? []),
    }),
  )

const collect = (
  byAccount: Record<string, ReadonlyArray<AccountTransaction>>,
) =>
  runCollect({
    accounts: [
      { bankAccountId: "checking", actualAccountId: "actual-checking" },
    ],
    syncDuration: Duration.days(30),
    categorize: false,
    categories: testCategories,
    payees: testPayees,
  }).pipe(Effect.provide(bankLayer(byAccount)))

const collectWith = (
  byAccount: Record<string, ReadonlyArray<AccountTransaction>>,
  opts: {
    readonly accounts: ReadonlyArray<{
      readonly bankAccountId: string
      readonly actualAccountId: string
    }>
    readonly payees: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly transfer_acct?: string
    }>
    readonly transferMatch: ReadonlyArray<{
      readonly token: string
      readonly actualAccountId: string
    }>
  },
) =>
  runCollect({
    accounts: opts.accounts,
    syncDuration: Duration.days(30),
    categorize: false,
    categories: testCategories,
    payees: opts.payees,
    transferMatch: opts.transferMatch,
  }).pipe(Effect.provide(bankLayer(byAccount)))

// ---------------------------------------------------------------------------
// externalId passthrough — a stable bank-supplied id is used verbatim as
// imported_id, bypassing the date+amount+ordinal scheme entirely.
// ---------------------------------------------------------------------------

it.effect("externalId passes through verbatim as imported_id", () =>
  Effect.gen(function* () {
    const results = yield* collect({
      checking: [
        {
          dateTime: date("2026-06-20T00:00:00Z"),
          amount: amount("-104.50"),
          payee: "Gold Ribbon",
          cleared: true,
          externalId: "trans_cmqm22ewv06w002lb7rnwd0i1",
        },
      ],
    })
    const [{ transactions }] = results
    assert.equal(transactions[0].imported_id, "trans_cmqm22ewv06w002lb7rnwd0i1")
  }),
)

// ---------------------------------------------------------------------------
// Pending prefix — a transaction with no externalId and cleared: false (the
// shape of an Akahu pending transaction, which has no _id) gets an ordinal
// id namespaced under PENDING_ID_PREFIX so it can never collide with, or be
// silently reused by, a posted transaction's stable externalId.
// ---------------------------------------------------------------------------

it.effect(
  "cleared:false with no externalId gets a pending-prefixed ordinal id",
  () =>
    Effect.gen(function* () {
      const results = yield* collect({
        checking: [
          {
            dateTime: date("2026-06-24T00:00:00Z"),
            amount: amount("-10.00"),
            payee: "Ekiben",
            cleared: false,
          },
        ],
      })
      const [{ transactions }] = results
      assert.isTrue(
        transactions[0].imported_id.startsWith(PENDING_ID_PREFIX),
        `expected pending-prefixed id, got "${transactions[0].imported_id}"`,
      )
      assert.equal(
        transactions[0].imported_id,
        `${PENDING_ID_PREFIX}20260624-1000-1`,
      )
    }),
)

// ---------------------------------------------------------------------------
// Ordinal fallback preserved — a cleared transaction with no externalId
// (e.g. a hypothetical bank adapter without stable ids) still gets the
// plain, unprefixed date+amount+ordinal id exactly as before this change.
// ---------------------------------------------------------------------------

it.effect(
  "cleared:true with no externalId falls back to a plain ordinal id",
  () =>
    Effect.gen(function* () {
      const results = yield* collect({
        checking: [
          {
            dateTime: date("2026-06-24T00:00:00Z"),
            amount: amount("-10.00"),
            payee: "No Id Bank",
            cleared: true,
          },
        ],
      })
      const [{ transactions }] = results
      assert.equal(transactions[0].imported_id, "20260624-1000-1")
    }),
)

// ---------------------------------------------------------------------------
// Same date+amount, different externalIds — the historical bug this whole
// fix targets: two transactions sharing a date+amount must not collide or
// shift ids run-to-run once they carry stable externalIds.
// ---------------------------------------------------------------------------

it.effect(
  "same date+amount with distinct externalIds never collide, regardless of order",
  () =>
    Effect.gen(function* () {
      const txA: AccountTransaction = {
        dateTime: date("2026-06-29T00:00:00Z"),
        amount: amount("-50.00"),
        payee: "Generate Managed Fund",
        cleared: true,
        externalId: "trans_generate_dd",
      }
      const txB: AccountTransaction = {
        dateTime: date("2026-06-29T00:00:00Z"),
        amount: amount("-50.00"),
        payee: "TFR TO bnz joint sav",
        cleared: true,
        externalId: "trans_bnz_standing_order",
      }

      const forward = yield* collect({ checking: [txA, txB] })
      const reversed = yield* collect({ checking: [txB, txA] })

      const idsForward = forward[0].transactions
        .map((t) => t.imported_id)
        .toSorted()
      const idsReversed = reversed[0].transactions
        .map((t) => t.imported_id)
        .toSorted()

      assert.deepStrictEqual(idsForward, [
        "trans_bnz_standing_order",
        "trans_generate_dd",
      ])
      assert.deepStrictEqual(
        idsForward,
        idsReversed,
        "ids must be identical regardless of feed order — this is the bug that duplicated BNZ transfers and dropped Generate contributions",
      )
    }),
)

// ---------------------------------------------------------------------------
// transferMatch — routes a recurring transfer to a destination account by a
// stable token (Akahu's `particulars`, falling back to `notes`), instead of
// relying on `meta.other_account` (absent for standing orders/direct
// debits) or an Actual rule matching the raw description.
// ---------------------------------------------------------------------------

it.effect(
  "transferMatch to a MANUAL (unsynced) account resolves the transfer payee directly",
  () =>
    Effect.gen(function* () {
      // Rabo has no Akahu feed of its own, so there's no independent
      // counterpart to pair with later — the transfer payee is set at
      // collect time, same as the existing meta.other_account path.
      const results = yield* collectWith(
        {
          checking: [
            {
              dateTime: date("2026-07-12T00:00:00Z"),
              amount: amount("-50.00"),
              payee: "RaboDirect kenziesavingFT26194GKHG4kenziesaving",
              particulars: "kenziesaving",
              cleared: true,
              externalId: "trans_rabo_kenzie",
            },
          ],
        },
        {
          accounts: [
            { bankAccountId: "checking", actualAccountId: "actual-checking" },
          ],
          payees: [
            ...testPayees,
            {
              id: "rabo-kenzie-payee",
              name: "Rabo Kenzie",
              transfer_acct: "actual-rabo-kenzie",
            },
          ],
          transferMatch: [
            { token: "kenziesaving", actualAccountId: "actual-rabo-kenzie" },
          ],
        },
      )
      const [{ transactions, linkCandidates }] = results
      assert.equal(
        linkCandidates.length,
        0,
        "manual destination should not need post-import linking",
      )
      assert.isFalse(
        "payee_name" in transactions[0],
        "should resolve to a transfer payee, not payee_name",
      )
      assert.equal(
        (transactions[0] as { payee: string }).payee,
        "rabo-kenzie-payee",
      )
    }),
)

it.effect(
  "transferMatch to a SYNCED account defers to post-import linking instead of setting a transfer payee",
  () =>
    Effect.gen(function* () {
      // BNZ Savings IS synced (has its own Akahu feed) — setting a transfer
      // payee here at collect time would make Actual auto-create a THIRD,
      // redundant row when the independently-fed BNZ credit also imports.
      const results = yield* collectWith(
        {
          checking: [
            {
              dateTime: date("2026-07-12T00:00:00Z"),
              amount: amount("-100.00"),
              payee: "TFR TO bnz joint sav jointipsave",
              particulars: "jointipsave",
              cleared: true,
              externalId: "trans_asb_tfr",
            },
          ],
          bnz: [],
        },
        {
          accounts: [
            { bankAccountId: "checking", actualAccountId: "actual-checking" },
            { bankAccountId: "bnz", actualAccountId: "actual-bnz" },
          ],
          payees: [
            ...testPayees,
            {
              id: "bnz-payee",
              name: "BNZ Savings",
              transfer_acct: "actual-bnz",
            },
          ],
          transferMatch: [
            { token: "jointipsave", actualAccountId: "actual-bnz" },
          ],
        },
      )
      const checking = results.find(
        (r) => r.actualAccountId === "actual-checking",
      )!
      assert.isTrue(
        "payee_name" in checking.transactions[0],
        "synced destination must NOT resolve to a transfer payee at collect time",
      )
      assert.equal(checking.linkCandidates.length, 1)
      assert.equal(checking.linkCandidates[0].targetAccountId, "actual-bnz")
      assert.equal(checking.linkCandidates[0].amount, -10000)
      assert.equal(checking.linkCandidates[0].imported_id, "trans_asb_tfr")
    }),
)

it.effect("transferMatch falls back to notes when particulars is absent", () =>
  Effect.gen(function* () {
    const results = yield* collectWith(
      {
        checking: [
          {
            dateTime: date("2026-07-12T00:00:00Z"),
            amount: amount("-50.00"),
            payee: "Fn Transfer to Card 0609cc Payment",
            notes: "Fn Transfer to Card 0609cc Payment",
            cleared: true,
            externalId: "trans_card_payment",
          },
        ],
      },
      {
        accounts: [
          { bankAccountId: "checking", actualAccountId: "actual-checking" },
        ],
        payees: [
          ...testPayees,
          {
            id: "card-payee",
            name: "Platinum Card",
            transfer_acct: "actual-card",
          },
        ],
        transferMatch: [
          { token: "Fn Transfer to Card 0609", actualAccountId: "actual-card" },
        ],
      },
    )
    const [{ transactions }] = results
    assert.equal((transactions[0] as { payee: string }).payee, "card-payee")
  }),
)

it.effect(
  "no matching token leaves the transaction as a plain payee_name import",
  () =>
    Effect.gen(function* () {
      const results = yield* collectWith(
        {
          checking: [
            {
              dateTime: date("2026-07-12T00:00:00Z"),
              amount: amount("-6.50"),
              payee: "AUCKLAND TRANSPORT AUCK AUCKLAND",
              cleared: true,
              externalId: "trans_at_hop",
            },
          ],
        },
        {
          accounts: [
            { bankAccountId: "checking", actualAccountId: "actual-checking" },
          ],
          payees: testPayees,
          transferMatch: [
            { token: "kenziesaving", actualAccountId: "actual-rabo-kenzie" },
          ],
        },
      )
      const [{ transactions, linkCandidates }] = results
      assert.isTrue("payee_name" in transactions[0])
      assert.equal(linkCandidates.length, 0)
    }),
)

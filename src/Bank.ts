/**
 * @since 1.0.0
 */
import {
  BigDecimal,
  Data,
  DateTime,
  type Effect,
  Order,
  ServiceMap,
} from "effect"

export class BankError extends Data.TaggedError("BankError")<{
  readonly reason: "AccountNotFound" | "Unauthorized" | "Unknown"
  readonly bank: string
  readonly cause?: unknown
}> {}

export class Bank extends ServiceMap.Service<
  Bank,
  {
    readonly exportAccount: (
      accountId: string,
      options: {
        readonly since: DateTime.Utc
      },
    ) => Effect.Effect<ReadonlyArray<AccountTransaction>, BankError>
  }
>()("Bank") {}

export interface AccountTransaction {
  readonly dateTime: DateTime.DateTime
  readonly amount: BigDecimal.BigDecimal
  readonly payee: string
  readonly notes?: string
  readonly cleared?: boolean
  readonly category?: string
  readonly type?: string
  readonly transfer?: string
  readonly externalId?: string
  /**
   * A stable routing token for this transaction, independent of the
   * human-readable description (which often embeds a per-transaction
   * reference number that changes every time, e.g. Akahu's
   * `meta.particulars`). Used to match recurring transfers (standing
   * orders, direct debits) to a destination account via `--transfer-match`,
   * without relying on fragile substring matches against `notes`.
   */
  readonly particulars?: string
}

export const AccountTransactionOrder = Order.Struct({
  dateTime: DateTime.Order,
  amount: BigDecimal.Order,
  payee: Order.String,
})

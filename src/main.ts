import { Command, Flag } from "effect/unstable/cli"
import {
  Config,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Struct,
} from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Sync from "./Sync.ts"
import { Actual } from "./Actual.ts"
import { AkahuLive } from "./Bank/Akahu.ts"
import { UpBankLive } from "./Bank/Up.ts"

const banks = {
  akahu: AkahuLive,
  up: UpBankLive,
} as const

const bank = Flag.choice("bank", Struct.keys(banks)).pipe(
  Flag.withDescription("Which bank to use"),
)

const accounts = Flag.keyValuePair("accounts").pipe(
  Flag.withDescription(
    "Accounts to sync, in the format 'actual-account-id=bank-account-id'",
  ),
)

const syncDuration = Flag.integer("sync-days").pipe(
  Flag.withDescription("Number of days to sync (default: 30)"),
  Flag.withDefault(30),
  Flag.map(Duration.days),
)

const categorize = Flag.boolean("categorize").pipe(
  Flag.withAlias("c"),
  Flag.withDescription(
    "If the bank supports categorization, try to categorize transactions",
  ),
)

const categories = Flag.keyValuePair("categories").pipe(
  Flag.optional,
  Flag.withDescription(
    "Requires --categorize to have any effect. Maps the banks values to actual values with the format 'bank-category=actual-category'",
  ),
)

const timezone = Flag.string("timezone").pipe(
  Flag.withDescription(
    "The timezone to use to display transaction timestamps. Defaults to the bank timezone.",
  ),
  Flag.withFallbackConfig(Config.string("TIMEZONE")),
  Flag.map((tz) => DateTime.layerCurrentZoneNamed(tz)),
  Flag.withDefault(Layer.empty),
)

const clearedOnly = Flag.boolean("cleared-only").pipe(
  Flag.withDescription("Only sync cleared transactions"),
  Flag.withAlias("C"),
)

const transferMatch = Flag.keyValuePair("transfer-match").pipe(
  Flag.optional,
  Flag.withDescription(
    "Route a recurring transfer (standing order, direct debit) to a destination account by matching a stable token against the bank's transaction metadata, in the format 'token=actual-account-id'. Repeatable. If the destination is also being synced, both sides are linked as a transfer after import instead of a payee being set directly.",
  ),
)

const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription(
    "Log every intended change instead of writing it to Actual",
  ),
)

const actualsync = Command.make("actualsync", {
  bank,
  accounts,
  categorize,
  categories,
  timezone,
  syncDuration,
  clearedOnly,
  transferMatch,
  dryRun,
}).pipe(
  Command.withHandler(
    ({
      accounts,
      categorize,
      categories,
      bank,
      syncDuration,
      clearedOnly,
      transferMatch,
      dryRun,
    }) =>
      Sync.run({
        accounts: Object.entries(accounts).map(
          ([actualAccountId, bankAccountId]) => ({
            actualAccountId,
            bankAccountId,
          }),
        ),
        categorize,
        categoryMapping: Option.getOrUndefined(
          Option.map(categories, (categoriesOption) =>
            Object.entries(categoriesOption).map(
              ([bankCategory, actualCategory]) => ({
                bankCategory,
                actualCategory,
              }),
            ),
          ),
        ),
        syncDuration,
        clearedOnly,
        transferMatch: Option.getOrUndefined(
          Option.map(transferMatch, (transferMatchOption) =>
            Object.entries(transferMatchOption).map(
              ([token, actualAccountId]) => ({
                token,
                actualAccountId,
              }),
            ),
          ),
        ),
        dryRun,
      }).pipe(Effect.provide(Layer.mergeAll(banks[bank], Actual.layer))),
  ),
  Command.provide(({ timezone }) => timezone),
)

const run = Command.runWith(actualsync, {
  version: "0.0.1",
})

run(process.argv).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)

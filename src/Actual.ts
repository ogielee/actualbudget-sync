/**
 * @since 1.0.0
 */
import {
  Config,
  Data,
  Effect,
  Layer,
  Redacted,
  Schema,
  ServiceMap,
  Stream,
} from "effect"
import * as Api from "@actual-app/api"
import { compareVersions } from "compare-versions"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Npm } from "./Npm.ts"
import { NodeHttpClient } from "@effect/platform-node"
// TransactionEntity removed from @actual-app/api in 26.5.2 — define locally,
// matching @actual-app/core's shape (only `payee` allows null; date/amount
// are always present since every query here selects "*").
interface TransactionEntity {
  id: string
  imported_id?: string
  imported_payee?: string
  payee?: string | null
  category?: string
  cleared?: boolean
  date: string
  amount: number
  notes?: string
  transfer_id?: string
  is_parent?: boolean
  is_child?: boolean
  parent_id?: string
  starting_balance_flag?: boolean
  reconciled?: boolean
  tombstone?: boolean
}
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

// @actual-app/api stopped exporting ./package.json (26.7+), so resolve the
// installed package on disk and read its version directly (fs bypasses the
// package "exports" restriction).
function readInstalledApiVersion(): string {
  const require = createRequire(import.meta.url)
  let dir = dirname(require.resolve("@actual-app/api"))
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as { name?: string; version?: string }
      if (pkg.name === "@actual-app/api" && pkg.version) return pkg.version
    } catch {
      // no readable package.json here — keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error("Unable to determine installed @actual-app/api version")
}
const installedApiVersion = readInstalledApiVersion()

// forceAddTransaction (see Sync.ts) is an undocumented field on
// @actual-app/api's ImportTransactionEntity — absent from the published
// type, only found by reading the server's own dist bundle
// (reconcileTransactions in sync.ts: `if (match && !trans.forceAddTransaction)`).
// It's the only thing preventing Actual's server-side fuzzy matcher from
// silently absorbing a real bank transaction into an unrelated existing row
// (confirmed in production, 2026-07: twice absorbed a real transaction into
// a manual receipt-split child). Because it's undocumented, a future
// @actual-app/api release could drop it without a type error anywhere in
// this codebase — this checks the shipped dependency's own bundle for the
// literal string at startup and fails loudly instead of silently
// re-enabling that failure mode. Only covers the statically installed
// package this tool ships with; a version downloaded at runtime to match a
// newer server (see below) is not re-checked.
function verifyForceAddTransactionSupported(): void {
  const require = createRequire(import.meta.url)
  const distPath = require.resolve("@actual-app/api")
  const contents = readFileSync(distPath, "utf8")
  if (!contents.includes("forceAddTransaction")) {
    throw new Error(
      `@actual-app/api@${installedApiVersion} no longer appears to support ` +
        `forceAddTransaction (checked ${distPath}). This tool relies on it to ` +
        "prevent Actual's server-side fuzzy transaction matching from " +
        "silently absorbing real bank transactions into unrelated rows " +
        '(the 2026-07 "Ekiben" incident). Investigate before syncing.',
    )
  }
}
verifyForceAddTransactionSupported()

export type Query = ReturnType<typeof Api.q>

export class ActualError extends Data.TaggedError("ActualError")<{
  readonly cause: unknown
}> {}

export class Actual extends ServiceMap.Service<Actual>()("Actual", {
  make: Effect.gen(function* () {
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
    )
    const npm = yield* Npm
    const dataDir = yield* Config.string("ACTUAL_DATA").pipe(
      Config.withDefault("data"),
    )
    const server = yield* Config.url("ACTUAL_SERVER")
    const password = yield* Config.redacted("ACTUAL_PASSWORD")
    const encryptionPassword = yield* Config.redacted(
      "ACTUAL_ENCRYPTION_PASSWORD",
    ).pipe(Config.withDefault(undefined))
    const syncId = yield* Config.string("ACTUAL_SYNC_ID")

    if (!server.pathname.endsWith("/")) {
      server.pathname += "/"
    }

    const serverVersion = httpClient.get(`${server.toString()}info`).pipe(
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(
          Schema.Struct({
            build: Schema.Struct({
              version: Schema.String,
            }),
          }),
        ),
      ),
      Effect.map((_) => _.build.version),
    )

    const api = yield* Effect.gen(function* () {
      const version = yield* serverVersion
      if (version === installedApiVersion) {
        return Api
      }
      // Only download the server's version if it is strictly newer than what
      // is installed. If the installed version is newer (e.g. the server
      // temporarily reported an older version while the DB already has newer
      // migrations applied), keep the installed version so we don't
      // inadvertently downgrade and break migration compatibility.
      if (compareVersions(version, installedApiVersion) <= 0) {
        yield* Effect.logInfo(
          "Server version is older than installed — keeping installed version.",
        ).pipe(
          Effect.annotateLogs({
            serverVersion: version,
            localVersion: installedApiVersion,
          }),
        )
        return Api
      }
      yield* Effect.logInfo(
        "Actual API version mismatch. Attempting to update.",
      ).pipe(
        Effect.annotateLogs({
          serverVersion: version,
          localVersion: installedApiVersion,
        }),
      )
      const name = yield* npm.install({
        packageName: "@actual-app/api",
        version,
      })
      return yield* Effect.promise(() => import(name) as Promise<typeof Api>)
    }).pipe(
      Effect.tapCause(Effect.logWarning),
      Effect.orElseSucceed(() => Api),
      Effect.annotateLogs({
        module: "Actual",
        method: "getApi",
      }),
    )

    const use = <A>(
      f: (api: typeof Api) => Promise<A>,
    ): Effect.Effect<A, ActualError> =>
      Effect.tryPromise({
        try: () => f(api),
        catch: (cause) => new ActualError({ cause }),
      })

    yield* Effect.acquireRelease(
      use((_) =>
        _.init({
          dataDir,
          serverURL: server.toString(),
          password: Redacted.value(password),
        }),
      ),
      () => Effect.promise(() => api.shutdown()),
    )

    const sync = Effect.promise(() => api.sync())

    yield* use((_) =>
      _.downloadBudget(
        syncId,
        encryptionPassword
          ? { password: Redacted.value(encryptionPassword) }
          : {},
      ),
    )
    yield* Effect.addFinalizer(() => sync)
    yield* sync

    const query = <A>(f: (q: (typeof Api)["q"]) => Query) =>
      use(({ aqlQuery, q }) => aqlQuery(f(q))).pipe(
        // oxlint-disable-next-line typescript/no-explicit-any
        Effect.map((result: any) => result.data as ReadonlyArray<A>),
      )

    const findImported = (
      importedIds: ReadonlyArray<string>,
      accountId: string,
    ) => {
      if (importedIds.length === 0) {
        return Effect.succeed(new Map<string, TransactionEntity>())
      }
      return Stream.fromIterable(importedIds).pipe(
        // SQLite has a default maximum of 999 variables per query, so we chunk the queries to avoid hitting that limit.
        Stream.rechunk(500),
        Stream.chunks,
        Stream.mapEffect((chunk) =>
          query<TransactionEntity>(
            (q) =>
              q("transactions")
                .select(["*"])
                .filter({
                  account: accountId,
                  $or: chunk.map((imported_id) => ({ imported_id })),
                })
                // Without this, AQL hides split parents, so a split
                // transaction's own imported_id is invisible here and gets
                // re-sent by the sync on every run.
                .options({ splits: "all" }),
            // .withDead() removed so deleted transactions are re-imported on next sync,
          ),
        ),
        Stream.runFold(
          () => new Map<string, TransactionEntity>(),
          (acc, items) => {
            for (const item of items) {
              acc.set(item.imported_id!, item)
            }
            return acc
          },
        ),
      )
    }

    // Rows created from an Akahu *pending* transaction (which has no stable
    // id) carry a "pending-<date><amount>-<n>" imported_id — see
    // PENDING_ID_PREFIX in Sync.ts. When the same transaction later posts
    // with a real externalId, `findImported` won't find it under its old
    // pending id, so the sync would otherwise insert a duplicate instead of
    // reconciling it. This lists the outstanding pending-sourced rows so the
    // sync can match posted transactions against them explicitly.
    const findPendingCandidates = (accountId: string) =>
      query<TransactionEntity>((q) =>
        q("transactions")
          .select(["*"])
          .filter({
            account: accountId,
            cleared: false,
            imported_id: { $like: "pending-%" },
          })
          .options({ splits: "all" }),
      )

    // Candidates for cross-account transfer linking (Sync.ts's
    // `transferMatch` mechanism): a cleared, not-yet-linked row in the
    // target account with the exact opposite amount, within a few days of
    // the source row's date. Excludes rows already part of a transfer so a
    // previously-linked pair is never re-matched or overwritten.
    const findUnlinkedTransferCandidate = (
      accountId: string,
      amount: number,
      date: string,
    ) =>
      query<TransactionEntity>((q) =>
        q("transactions")
          .select(["*"])
          .filter({
            account: accountId,
            amount,
            cleared: true,
            transfer_id: null,
            // Two operators in ONE filter object ({ $gte, $lte }) silently
            // drops the $lte in this AQL version — verified empirically
            // 2026-07-17 (unbounded upper range let a Jun-29 transfer link
            // to a Jul-13 counterpart). The $and form applies both bounds.
            date: { $gte: shiftDate(date, -3) },
            $and: [{ date: { $lte: shiftDate(date, 3) } }],
          })
          .options({ splits: "all" }),
      ).pipe(Effect.map((rows) => rows[0]))

    return {
      use,
      query,
      findImported,
      findPendingCandidates,
      findUnlinkedTransferCandidate,
    } as const
  }),
}) {
  static layer = Layer.effect(this)(this.make).pipe(
    Layer.provide([NodeHttpClient.layerUndici, Npm.layer]),
  )
}

const shiftDate = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

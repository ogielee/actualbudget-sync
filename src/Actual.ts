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
// TransactionEntity removed from @actual-app/api in 26.5.2 — define locally
interface TransactionEntity {
  id: string
  imported_id?: string | null
  imported_payee?: string | null
  payee?: string | null
  category?: string | null
  cleared?: boolean | null
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
                }),
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

    return { use, query, findImported } as const
  }),
}) {
  static layer = Layer.effect(this)(this.make).pipe(
    Layer.provide([NodeHttpClient.layerUndici, Npm.layer]),
  )
}

// One-time migration: rewrite existing Actual rows' ordinal imported_id
// (date+amount+counter, from the old unstable scheme) to Akahu's real,
// stable transaction _id — the same id the sync now assigns going forward
// (see externalId in src/Bank/Akahu.ts).
//
// Matching is deliberately conservative: for a given (account, NZ-date,
// amount) key, a rewrite only happens when the count of existing Actual
// rows exactly equals the count of Akahu transactions at that key. Any
// mismatch (more Actual rows than Akahu txns = likely duplicate; fewer =
// likely a transaction Actual never received, e.g. Ekiben) is left
// untouched and printed for review — Phase 2 (recovery + cleanup) resolves
// those by running the sync fresh and deleting confirmed phantom rows.
//
// Usage:
//   node scripts/migrate-imported-ids.mjs [--window-days=35]              (dry run)
//   node scripts/migrate-imported-ids.mjs [--window-days=35] --apply      (writes + undo log)
import { writeFileSync } from "node:fs"
import {
  ACCOUNTS,
  akahuTransactions,
  loadActualApi,
  loadEnv,
  initActual,
  toNZDate,
} from "./reconcile-lib.mjs"

const args = process.argv.slice(2)
const windowDays = Number(
  args.find((a) => a.startsWith("--window-days="))?.split("=")[1] ?? 35,
)
const apply = args.includes("--apply")

// Ordinal ids look like YYYYMMDD<amountInt>-<n>. Anything else (a "trans_..."
// externalId already migrated, or a "pending-..." row) is left alone.
const ORDINAL_ID = /^\d{8}-?-?\d+-\d+$/

loadEnv()
const api = await loadActualApi()
await initActual(api)
const q = async (build) => (await api.aqlQuery(build(api.q))).data

const startIso = new Date(Date.now() - windowDays * 86400000).toISOString()
const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
const logPath = `C:\\Users\\orlan\\akahu-sync\\logs\\migrate-imported-ids-${timestamp}-${apply ? "applied" : "dryrun"}.csv`

// A stale row can only be migrated to a real Akahu id if NO other row in
// the whole budget already carries that id. Without this, migrating a
// stale row whose real counterpart was ALREADY freshly imported by an
// intervening sync run creates two rows sharing one imported_id — a real
// collision hit in production on 2026-07-17 (an old, never-migrated BNZ
// row and a fresh sync-imported row both eligible for the same real id).
const usedRealIds = new Set(
  (
    await q((qq) =>
      qq("transactions").select(["imported_id"]).options({ splits: "all" }).limit(50000),
    )
  )
    .map((t) => t.imported_id)
    .filter((id) => typeof id === "string" && id.startsWith("trans_")),
)

const csvRows = [
  "account,row_id,old_imported_id,new_imported_id,date,amount,description",
]

let totalMatched = 0
let totalAmbiguousGroups = 0
let totalAmbiguousRows = 0

for (const acct of ACCOUNTS) {
  console.log(`\n=== ${acct.name} ===`)

  const actualRows = await q((qq) =>
    qq("transactions")
      .filter({ account: acct.actualId, date: { $gte: toNZDate(startIso) } })
      .select(["id", "date", "amount", "imported_id", "is_child", "notes"])
      .options({ splits: "all" })
      .limit(5000),
  )
  const candidates = actualRows.filter(
    (t) => !t.is_child && t.imported_id && ORDINAL_ID.test(t.imported_id),
  )

  const akTxns = await akahuTransactions(acct.akahuId, startIso)

  // Group by (date, amount) first — a coarse bucket that same-day identical
  // amounts (e.g. weekly $100/$50 direct debits) all fall into together.
  const byKey = new Map()
  for (const t of candidates) {
    const key = `${t.date}|${t.amount}`
    ;(byKey.get(key) ?? byKey.set(key, { actual: [], akahu: [] }).get(key)).actual.push(t)
  }
  for (const t of akTxns) {
    const key = `${toNZDate(t.date)}|${Math.round(t.amount * 100)}`
    ;(byKey.get(key) ?? byKey.set(key, { actual: [], akahu: [] }).get(key)).akahu.push(t)
  }

  for (const [key, { actual, akahu }] of byKey) {
    if (actual.length === 0) continue // nothing to migrate at this key

    // Tier 1: within the (date, amount) bucket, pair rows whose notes match
    // an Akahu description UNIQUELY (exactly one actual row and exactly one
    // akahu txn share that text). This is what correctly separates a
    // genuine duplicate (two actual rows sharing the same notes text, e.g.
    // two "TFR TO bnz..." rows from the ordinal-id bug) from the other,
    // unrelated same-amount transactions in the same bucket (e.g. that
    // day's Generate / Rabo debits) — a count-only comparison across the
    // whole bucket cannot tell these apart and would silently mis-assign.
    const actualByText = new Map()
    for (const t of actual)
      (actualByText.get(t.notes ?? "") ?? actualByText.set(t.notes ?? "", []).get(t.notes ?? "")).push(t)
    const akahuByText = new Map()
    for (const t of akahu)
      (akahuByText.get(t.description) ?? akahuByText.set(t.description, []).get(t.description)).push(t)

    const matchedActual = new Set()
    const matchedAkahu = new Set()
    const pairs = []
    for (const [text, actualGroup] of actualByText) {
      const akahuGroup = akahuByText.get(text)
      if (actualGroup.length === 1 && akahuGroup?.length === 1) {
        pairs.push([actualGroup[0], akahuGroup[0], "text"])
        matchedActual.add(actualGroup[0].id)
        matchedAkahu.add(akahuGroup[0]._id)
      }
    }

    // Tier 2: whatever is left in the bucket after Tier 1 — safe to pair
    // ONLY when exactly one candidate remains on each side (pairing by
    // elimination; there is nothing else it could be). Covers rows whose
    // notes were overwritten by something else (e.g. a receipt-splitting
    // tool rewriting a split parent's notes) but which are otherwise the
    // sole transaction of that amount that day.
    const remainingActual = actual.filter((t) => !matchedActual.has(t.id))
    const remainingAkahu = akahu.filter((t) => !matchedAkahu.has(t._id))
    if (remainingActual.length === 1 && remainingAkahu.length === 1) {
      pairs.push([remainingActual[0], remainingAkahu[0], "elimination"])
      matchedActual.add(remainingActual[0].id)
      matchedAkahu.add(remainingAkahu[0]._id)
    }

    // Collision guard: never assign a real id that's already in use on
    // another row (almost always because an intervening sync run already
    // freshly imported that real transaction while this stale row sat
    // un-migrated). Demote these to "unresolved" instead of migrating —
    // the stale row becomes cleanup-phantoms.mjs's job (it's now a
    // provable duplicate of the row that already holds the real id).
    const safePairs = []
    const collisions = []
    for (const pair of pairs) {
      if (usedRealIds.has(pair[1]._id)) collisions.push(pair)
      else safePairs.push(pair)
    }

    const unmatchedActual = [
      ...actual.filter((t) => !matchedActual.has(t.id)),
      ...collisions.map(([row]) => row),
    ]
    const unmatchedAkahu = akahu.filter((t) => !matchedAkahu.has(t._id))
    if (unmatchedActual.length > 0 || unmatchedAkahu.length > 0) {
      totalAmbiguousGroups++
      totalAmbiguousRows += unmatchedActual.length
      console.log(
        `  SKIP (ambiguous) ${key}: ${unmatchedActual.length} actual row(s) vs ${unmatchedAkahu.length} akahu txn(s) unresolved after text matching`,
      )
      for (const t of unmatchedActual)
        console.log(`      actual row ${t.id} imp=${t.imported_id} notes="${t.notes ?? ""}"`)
      for (const t of unmatchedAkahu)
        console.log(`      akahu txn  ${t._id} "${t.description}"`)
      for (const [row, ak] of collisions)
        console.log(`      COLLISION: ${row.id} would target ${ak._id}, which another row already has`)
    }

    for (const [row, ak, how] of safePairs) {
      totalMatched++
      csvRows.push(
        [
          acct.name,
          row.id,
          row.imported_id,
          ak._id,
          row.date,
          (row.amount / 100).toFixed(2),
          JSON.stringify(ak.description),
        ].join(","),
      )
      console.log(`  MATCH (${how})  ${row.date} ${(row.amount / 100).toFixed(2).padStart(10)}  ${row.imported_id} -> ${ak._id}`)
      usedRealIds.add(ak._id)
      if (apply) {
        await api.updateTransaction(row.id, { imported_id: ak._id })
      }
    }
  }
}

writeFileSync(logPath, csvRows.join("\n"), "utf8")

console.log(`\n=== SUMMARY ===`)
console.log(`  matched & ${apply ? "applied" : "would apply"}: ${totalMatched}`)
console.log(`  ambiguous groups skipped: ${totalAmbiguousGroups} (${totalAmbiguousRows} actual rows) — see above, resolved in Phase 2`)
console.log(`  log written: ${logPath}`)
if (!apply) console.log(`\n  Dry run only — re-run with --apply to write changes.`)

await api.shutdown()

// Shared helpers for the reconciliation / migration / cleanup scripts.
// Plain Node ESM (not part of the tsup build) — run directly with `node`.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

export const ENV_PATH = "C:\\Users\\orlan\\akahu-sync\\.env"
export const REPO_PACKAGE_JSON = "D:\\repos\\actualbudget-sync\\package.json"

export function loadEnv(envPath = ENV_PATH) {
  const text = readFileSync(envPath, "utf8").replace(/^﻿/, "")
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("=") || /^\s*#/.test(line)) continue
    const i = line.indexOf("=")
    process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
}

export async function loadActualApi() {
  const require = createRequire(REPO_PACKAGE_JSON)
  const mod = await import(
    pathToFileURL(require.resolve("@actual-app/api")).href
  )
  return mod.default ?? mod
}

export async function initActual(api) {
  await api.init({
    dataDir: process.env.ACTUAL_DATA,
    serverURL: process.env.ACTUAL_SERVER,
    password: process.env.ACTUAL_PASSWORD,
  })
  await api.downloadBudget(
    process.env.ACTUAL_SYNC_ID,
    process.env.ACTUAL_ENCRYPTION_PASSWORD
      ? { password: process.env.ACTUAL_ENCRYPTION_PASSWORD }
      : {},
  )
  await api.sync()
}

export function akahuHeaders() {
  return {
    "X-Akahu-Id": process.env.AKAHU_APP_TOKEN,
    Authorization: `Bearer ${process.env.AKAHU_USER_TOKEN}`,
  }
}

export async function akahuAccount(akahuId) {
  const r = await fetch(`https://api.akahu.io/v1/accounts/${akahuId}`, {
    headers: akahuHeaders(),
  })
  const j = await r.json()
  if (!j.success) throw new Error(`Akahu account fetch failed: ${JSON.stringify(j)}`)
  return j.item
}

export async function akahuTransactions(akahuId, startIso) {
  const all = []
  let cursor
  do {
    const url = new URL(
      `https://api.akahu.io/v1/accounts/${akahuId}/transactions`,
    )
    url.searchParams.set("start", startIso)
    if (cursor) url.searchParams.set("cursor", cursor)
    const j = await (await fetch(url, { headers: akahuHeaders() })).json()
    if (!j.success) throw new Error(`Akahu tx fetch failed: ${JSON.stringify(j)}`)
    all.push(...j.items)
    cursor = j.cursor?.next
  } while (cursor)
  return all
}

// Akahu transaction dates are UTC noon; this converts to the NZ calendar date
// used everywhere in Actual.
export function toNZDate(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso))
}

export function dayNum(dateStr) {
  return Math.round(Date.parse(dateStr + "T00:00:00Z") / 86400000)
}

// Account map: actual UUID = akahu account id. baseline selects which Akahu
// balance field this account should reconcile against.
//   "current"   — real money owed/held (savings, credit cards)
//   "available" — for the ASB Checking offset/revolving-credit account,
//                 which is deliberately modelled without the facility
//                 drawdown; see actualbudget-sync-context.md and the
//                 2026-07-17 reconciliation session.
export const ACCOUNTS = [
  {
    name: "ASB Checking",
    actualId: "10170e5c-b4c0-423f-9125-b1b74a9dcb69",
    akahuId: "acc_cmprk93fp005b02l7ficqc3wv",
    baseline: "available",
  },
  {
    name: "ASB Savings",
    actualId: "ccac8724-7348-4eb3-a70c-39cfe6b66661",
    akahuId: "acc_cmprk93fv005d02l7ezjoczny",
    baseline: "current",
  },
  {
    name: "ASB Platinum Card",
    actualId: "73894fda-4db3-4dcc-92c5-f62973436c70",
    akahuId: "acc_cmprk93g1005f02l70lfa5m7z",
    baseline: "current",
    diffShouldEqualUncleared: true,
  },
  {
    name: "BNZ Savings",
    actualId: "d2edf7ee-2fb7-43e5-999d-1e91c58f95c6",
    akahuId: "acc_cmprkay06003n02kzf8ab5jz1",
    baseline: "current",
  },
  {
    name: "American Express",
    actualId: "79e1de12-ee3c-413f-8b3b-1252aa33f046",
    akahuId: "acc_cmprke32w007402l26vb4d5hv",
    baseline: "current",
    diffShouldEqualUncleared: true,
  },
]

// Both tokens route to Premiums Saver (Joint) since 2026-06-22 — the bank
// started depositing kenziesaving transfers into the same account as
// jointsaving instead of NoticeSaver (Kenzie); see the 2026-07-19 Rabo
// reconciliation fix.
export const RABO_TRANSFER_MATCH = [
  {
    particulars: "kenziesaving",
    actualId: "726e8b38-3063-4672-8016-26001d6dacde",
    name: "Rabo Premiums Saver (Joint)",
  },
  {
    particulars: "jointsaving",
    actualId: "726e8b38-3063-4672-8016-26001d6dacde",
    name: "Rabo Premiums Saver (Joint)",
  },
]

export const cents = (dollars) => Math.round(dollars * 100)
export const dollars = (c) => (c / 100).toFixed(2)

# Context: actualbudget-sync Local Fork (Ogie)

## What this is

A local fork of [tim-smart/actualbudget-sync](https://github.com/tim-smart/actualbudget-sync) on Ogie's Windows laptop, modified to fix missing transfer detection between accounts. The tool syncs bank transactions from Akahu (NZ open-banking aggregator) into Actual Budget (open-source, self-hosted on PikaPods).

---

## Architecture

```
BNZ ──┐
ASB ──┤
      ├──► Akahu API ──► actualbudget-sync CLI ──► Actual Budget (PikaPods)
Amex ─┤
Rabo ─┘
                                │
                                └──► Weekly rollup ──► Excel/Google Sheets (TODO)
```

---

## Environment

| Item              | Value                                     |
| ----------------- | ----------------------------------------- |
| OS                | Windows 11                                |
| Node              | v22.22.0 (installed via WinGet)           |
| pnpm              | Installed via Corepack (Node 22 built-in) |
| Repo location     | `D:\repos\actualbudget-sync`              |
| Config folder     | `C:\Users\orlan\akahu-sync\`              |
| .env file         | `C:\Users\orlan\akahu-sync\.env`          |
| sync script       | `C:\Users\orlan\akahu-sync\sync.ps1`      |
| Actual data cache | `C:\Users\orlan\akahu-sync\data\`         |

---

## Current State

### What is done

- Repo cloned to `D:\repos\actualbudget-sync`
- Dependencies installed (`pnpm install` ✅)
- Project built (`pnpm build` ✅) — output is in `dist\`
- `pnpm link --global` was run but the global shim does **not** work
  - Root cause: `actualsync` binary not appearing in PATH despite pnpm setup
  - `dir C:\Users\orlan\AppData\Local\pnpm` — check if shim exists here

### How to run (use this instead of global shim)

Run the CLI directly via Node from the repo:

```powershell
node D:\repos\actualbudget-sync\dist\main.js --version
```

If `dist\main.js` doesn't exist, check `dir D:\repos\actualbudget-sync\dist` for the actual entry point filename.

### sync.ps1 invocation — update this line

Replace `actualsync` with the direct node call:

```powershell
node D:\repos\actualbudget-sync\dist\main.js --bank akahu --sync-days 30 `
  --accounts "actual-bnz-uuid=akahu-bnz-acc-id" `
  --accounts "actual-asb-uuid=akahu-asb-acc-id" `
  --accounts "actual-amex-uuid=akahu-amex-acc-id" `
  --accounts "actual-rabo-uuid=akahu-rabo-acc-id"
```

Account IDs are placeholders — real IDs to be filled from:

- Akahu: `https://my.akahu.nz/connections/conn_xxx/acc_xxxxxxxxx` (the `acc_xxx` part)
- Actual: account URL in PikaPods UI (UUID format)

---

## Pending Work: Transfer Fix

### Problem

When Ogie moves money between two of his accounts (e.g. BNZ → ASB), the sync creates two unlinked transactions — a debit in one account and a credit in the other — instead of a proper Actual Budget transfer. This inflates both spending and income.

### Root cause

`src/Bank/Akahu.ts` — the `Transaction` schema does not include the `type` field that Akahu returns. Akahu tags inter-account transfers with `type: "TRANSFER"` in its API response, but the current code ignores it.

### Key file

`D:\repos\actualbudget-sync\src\Bank\Akahu.ts`

The `Transaction` class (around line 210) currently maps:

- `_id`, `_account`, `_user`, `_connection`
- `date`, `description`, `amount`
- `merchant` (optional), `category` (optional)

Missing: `type` field (Akahu values: `"TRANSFER"`, `"CREDIT"`, `"DEBIT"`, etc.)

### What needs to happen

1. Add `type` to the `Transaction` schema in `Akahu.ts`
2. Expose it on the `AccountTransaction` interface in `src/Bank.ts`
3. In `src/Sync.ts` — investigate how transactions are passed to Actual Budget's API
4. When `type === "TRANSFER"` and both sides of the transfer are in the synced accounts list, create both transactions with a matching `transfer_id` so Actual Budget links them as a transfer

### Actual Budget transfer API

Transfers in Actual Budget are created by giving both transaction rows the same `transfer_id` value (a shared UUID). Reference: `@actual-app/api` importTransactions docs.

### Before implementing

- Read `src/Bank.ts` to see the `AccountTransaction` interface definition
- Read `src/Sync.ts` to understand how transactions are batched and sent to Actual
- Check what fields Akahu actually returns for transfer transactions (may need to log a raw response)

---

## Build & Run Commands

```bash
# From D:\repos\actualbudget-sync

# Install deps (first time only)
pnpm install

# Build after any code changes
pnpm build

# Test run (dry run / version check)
node dist\main.js --version

# Full sync (once .env and account IDs are confirmed)
# Load env vars first via sync.ps1, or export manually
node dist\main.js --bank akahu --sync-days 30 \
  --accounts "actual-id=akahu-id" \
  ...
```

---

## .env File Format (`C:\Users\orlan\akahu-sync\.env`)

```
ACTUAL_SERVER=https://yourpod.pikapod.net
ACTUAL_SYNC_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ACTUAL_PASSWORD=your-server-password
ACTUAL_ENCRYPTION_PASSWORD=your-e2e-password
ACTUAL_DATA=C:\Users\orlan\akahu-sync\data
AKAHU_APP_TOKEN=app_token_xxx
AKAHU_USER_TOKEN=user_token_xxx
```

---

## sync.ps1 Template (`C:\Users\orlan\akahu-sync\sync.ps1`)

```powershell
# Load credentials from .env
Get-Content "$PSScriptRoot\.env" | Where-Object { $_ -match '=' -and $_ -notmatch '^\s*#' } | ForEach-Object {
    $name, $value = $_ -split '=', 2
    [System.Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim())
}

# Run sync via local fork (not global shim)
node D:\repos\actualbudget-sync\dist\main.js --bank akahu --sync-days 30 `
  --accounts "actual-bnz-uuid=akahu-bnz-acc-id" `
  --accounts "actual-asb-uuid=akahu-asb-acc-id" `
  --accounts "actual-amex-uuid=akahu-amex-acc-id" `
  --accounts "actual-rabo-uuid=akahu-rabo-acc-id"
```

---

## Upstream Maintenance

To pull upstream changes into the local fork:

```bash
cd D:\repos\actualbudget-sync
git pull
pnpm install
pnpm build
```

No need to re-run `pnpm link --global` — the node direct call always uses the latest build.

---

## Related Context

- Actual Budget is hosted on PikaPods (self-hosted open source, not YNAB)
- Akahu Personal App tier: free, read-only, daily auto-refresh, 1-hour cooldown on manual refresh
- Rabobank: verify account is agribusiness type (online savings accounts are NOT supported by Akahu)
- Weekly Excel rollup from Actual Budget is a separate TODO item (not yet implemented)
- Task Scheduler entry: `akahu-sync` — runs `sync.ps1` daily at 8 AM

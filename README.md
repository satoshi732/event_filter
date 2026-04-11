# Solana Mev Labs

Token-centric on-chain analysis workbench.

The app stays idle until a user presses the run button in the web UI. Each run scans a recent block window, detects interesting contracts, preserves vulnerability-pattern scoring and proxy / EIP-7702 annotations, then reorganizes the final output by token.

## What the UI shows

### Token overview

The first screen lists tokens from the latest run with:

- token address
- token name / symbol when RPC metadata is available
- related contract count
- total transfer amount inside the scanned window
- search, sorting, and quick filtering in the dashboard
- filter state persisted in URL query params for refresh-safe navigation

### Token detail

Clicking a token opens grouped contract detail for that token:

- grouped contract sections
- transfer-in count and amount
- transfer-out count and amount
- current `balanceOf(contract)` via RPC
- matched whitelist / vulnerability patterns
- proxy implementation and EIP-7702 delegate annotations
- seen-pattern grouping when selector fingerprints match

### Contract overview

The dashboard contract table supports:

- search by contract / linkage / whitelist pattern
- sorting by total USD, flow, tx count, review count, token count, or label
- filtering by risk state and linkage type

## Pipeline shape

Each run does this:

1. Fetch latest block from Chainbase token transfers.
2. Scan the recent block window for token transfers and ETH-value traces.
3. Build candidate contracts from active addresses, `tx.to` entry contracts, proxies, and EIP-7702 delegates.
4. Score contracts with whitelist bytecode patterns plus activity bonus.
5. Re-aggregate transfer data by `(token, contract)`.
6. Fetch token metadata, token prices, and live balances through RPC.
7. Group related contracts by seen label or selector similarity.
8. Return the result to the web UI and persist normalized state in the database.

## Modular architecture (v2)

The runtime is now organized by module responsibility, with each module using its own repository wrapper instead of reaching straight into the monolithic DB layer:

1. `raw-data` module: collects transfer/traces from Chainbase and stores round raw rows.
2. `token-manager` module: deduplicates round tokens, inserts missing token catalog rows, updates prices for existing tokens.
3. `contract-manager` module: classifies/analyzes contracts, stores new contracts, and updates registry state for existing ones.
4. `selectors-manager` module: stores selectors for newly added contracts into `selectors_temp` and drives pattern review/sync from DB state.
5. `analysis` module: shared analysis helpers (`pattern hash`, `sync()` call detection, numeric safety).
6. `info-manager` module: stores per-token per-contract balances.
7. `dashboard` read-model: reshapes latest pipeline runs plus registry state into token/contract detail payloads for the web UI.
8. `pipeline` module: orchestrates module call order and builds web output payload.

Infrastructure dependencies remain: Chainbase, RPC, DB, and token metadata cache.

### DB layout

`db.ts` is now a small barrel layer. The actual DB code is split by domain:

- `src/db/raw-data.ts`
- `src/db/tokens.ts`
- `src/db/contracts.ts`
- `src/db/selectors.ts`
- `src/db/core.ts`
- `src/db/types.ts`

### Admin layout

CLI management commands are split by responsibility:

- `src/admin/whitelist.ts`
- `src/admin/patterns.ts`
- `src/admin/sync.ts`
- `src/admin/commands.ts` as the dispatcher

### New DB tables for modular flow

- `raw_rounds`
- `raw_token_transfers`
- `raw_value_traces`
- `tokens_registry`
- `contracts_registry`
- `selectors_temp`
- `token_contract_balances`

## Setup

### 1. Install and build

```bash
npm install
npm run build
```

### 2. Configure Settings In The Dashboard

Settings now live in the SQLite DB, not in `config.json`.

Use the `Settings` tab in the web UI to edit:

- monitored chains
- poll interval
- debug logging
- pattern sync credentials
- PancakeSwap price limiter
- per-chain RPC URLs, Chainbase keys, blocks per scan, and Multicall3
- AI audit providers and models

Notes:

- Runtime settings are hot-applied after save.
- `web.host` and `web.port` are stored in DB too, but the current HTTP listener keeps its existing bind until the next process start.
- RPC reads use `Multicall3` batching for `name`, `symbol`, `decimals`, and `balanceOf`.
- Contract `Total USD` is computed locally from token balances plus token USD prices gathered during the round.
- `pancakeswap_price` controls the rate limiter for PancakeSwap token price API requests.
- HTTPS cert/key paths auto-discover from the project `certs/` directory when the stored paths are blank or also point inside `certs/`. When a valid pair is auto-discovered, HTTPS is enabled automatically. `server.crt` / `server.key` are preferred when present; otherwise the newest complete pair is used.
- Legacy `config.json` is only treated as a one-time migration source if the DB has no settings yet.

## Running

### Start the web UI

```bash
node dist/index.js
```

Default URL:

```bash
http://127.0.0.1:8000
```

The server waits for user action. No scan starts automatically.

### Single run without the UI

```bash
node dist/index.js --once
```

### Restrict to one chain

```bash
node dist/index.js --chain bsc
```

## Output files

| Path | Description |
|------|-------------|
| `logs/app-YYYY-MM-DD.log` | Daily application log |

## Management commands

### Whitelist patterns

```bash
node dist/index.js --list-patterns
node dist/index.js --add-whitelist-pat <name> <hex> <selector|opcode|call> <score> [description]
node dist/index.js --rm-whitelist-pat <name>
```

### Seen selector patterns

```bash
node dist/index.js --mark-seen-pattern "0902f1ac,022c0d9f" "ExampleLabel"
node dist/index.js --import-seen-patterns ./patterns.json
```

### Legacy migration to v2 registry tables

```bash
npm run migrate:v2
```

## Current assumptions

- Token balance lookup assumes ERC-20 style `balanceOf(address)`.
- Token metadata lookup uses `name()`, `symbol()`, and `decimals()` through RPC.
- The scanned range is controlled by each chain's configured `blocksPerScan`.

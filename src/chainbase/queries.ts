import { initApiKeys, executeQueryAndWait } from './api.js';
import { getChainConfig } from '../config.js';
import { logger } from '../utils/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────
export interface TransferRow {
  transaction_hash: string;
  from_address:     string | null;
  to_address:       string | null;
  contract_address: string;
  value:            string | null;
}

export interface TraceRow {
  transaction_hash: string;
  from_address:     string | null;
  to_address:       string | null;
  value:            string;
}

export interface ContractRow {
  address:      string;
  bytecode:     string | null;
  block_number?: number;
  block_timestamp?: string | null;
}


// ── Helpers ───────────────────────────────────────────────────────────────────
function setup(chain: string): string {
  const cfg = getChainConfig(chain);
  if (!cfg.chainbaseKeys.length) throw new Error(`No API keys for ${chain}`);
  initApiKeys(cfg.chainbaseKeys);
  return cfg.tablePrefix;
}

// ── Query functions ───────────────────────────────────────────────────────────

/**
 * Latest block in token_transfers within the last 30 minutes.
 * Uses block_timestamp filter to avoid full table scan.
 */
export async function getLatestBlock(chain: string): Promise<number> {
  const tbl = setup(chain);
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const sql = `SELECT MAX(block_number) AS latest FROM ${tbl}.token_transfers WHERE block_timestamp >= '${cutoff}'`;
  logger.info(`[${chain}] Fetching latest block (transfers since ${cutoff})…`);
  const rows = await executeQueryAndWait<{ latest: number }>(sql);
  const latest = rows[0]?.latest ?? 0;
  logger.info(`[${chain}] Latest block: ${latest}`);
  return latest;
}

/**
 * All ERC20/721/1155 transfers in (fromBlock, toBlock].
 * Paginated to handle large ranges.
 */
export async function getTransfers(
  chain: string,
  fromBlock: number,
  toBlock: number,
): Promise<TransferRow[]> {
  const tbl    = setup(chain);
  const PAGE   = 50_000;
  const all: TransferRow[] = [];
  let offset   = 0;

  logger.info(`[${chain}] Fetching transfers blocks ${fromBlock}→${toBlock}…`);
  while (true) {
    const sql = `
      SELECT
        transaction_hash,
        from_address,
        to_address,
        contract_address,
        CAST(value AS VARCHAR) AS value
      FROM ${tbl}.token_transfers
      WHERE block_number > ${fromBlock}
        AND block_number <= ${toBlock}
        AND value > 0
      ORDER BY block_number ASC
      LIMIT ${PAGE} OFFSET ${offset}
    `;
    const page = await executeQueryAndWait<TransferRow>(sql);
    all.push(...page);
    logger.info(`[${chain}] transfers page offset=${offset} → ${page.length} rows (total ${all.length})`);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

/**
 * ETH-moving traces: from_address that sent ≥ 0.01 ETH in trace_calls.
 * Only includes traces with non-empty input (excludes plain EOA→EOA ETH sends).
 */
export async function getValueTraces(
  chain: string,
  fromBlock: number,
  toBlock: number,
): Promise<TraceRow[]> {
  const tbl    = setup(chain);
  const PAGE   = 50_000;
  const all: TraceRow[] = [];
  let offset   = 0;

  logger.info(`[${chain}] Fetching value traces blocks ${fromBlock}→${toBlock}…`);
  while (true) {
    const sql = `
      SELECT
        transaction_hash,
        from_address,
        to_address,
        CAST(value AS VARCHAR) AS value
      FROM ${tbl}.trace_calls
      WHERE block_number > ${fromBlock}
        AND block_number <= ${toBlock}
        AND value > 10000000000000000 -- 0.01 ETH
      ORDER BY block_number ASC
      LIMIT ${PAGE} OFFSET ${offset}
    `;
    const page = await executeQueryAndWait<TraceRow>(sql);
    all.push(...page);
    logger.info(`[${chain}] value-traces page offset=${offset} → ${page.length} rows (total ${all.length})`);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

/**
 * Fetch DELEGATECALL traces in the block range.
 * Returns Map<proxy_address → impl_address>.
 * If a proxy delegates to multiple impls, the most frequent one wins.
 */
export interface DelegateCallRow {
  from_address: string;
  to_address:   string;
  cnt:          number;
}

export async function getDelegateCalls(
  chain: string,
  fromBlock: number,
  toBlock: number,
): Promise<Map<string, string>> {
  const tbl = setup(chain);
  const map = new Map<string, string>();

  logger.info(`[${chain}] Fetching delegatecall traces blocks ${fromBlock}→${toBlock}…`);
  const sql = `
    SELECT
      from_address,
      to_address,
      COUNT(*) AS cnt
    FROM ${tbl}.trace_calls
    WHERE block_number > ${fromBlock}
      AND block_number <= ${toBlock}
      AND call_type = 'delegatecall'
      AND from_address != to_address
    GROUP BY from_address, to_address
    ORDER BY cnt DESC
  `;
  const rows = await executeQueryAndWait<DelegateCallRow>(sql);

  // First occurrence per from_address wins (highest count due to ORDER BY)
  for (const r of rows) {
    const proxy = r.from_address.toLowerCase();
    const impl  = r.to_address.toLowerCase();
    if (!map.has(proxy)) map.set(proxy, impl);
  }

  logger.info(`[${chain}] Delegatecall traces: ${rows.length} pairs → ${map.size} unique proxies`);
  return map;
}

/**
 * Fetch bytecode + deploy block for up to 1000 addresses at a time from the contracts table.
 * Returns Map<address_lowercase → { bytecode, block_number }>.
 * Addresses not found in the table are mapped to { bytecode: '', block_number: 0 }.
 */
export interface ContractInfo {
  bytecode:     string;   // hex, no 0x prefix
  block_number: number;   // deploy block
  block_timestamp: string | null;
}

export async function getContractInfos(
  chain: string,
  addresses: string[],
): Promise<Map<string, ContractInfo>> {
  const tbl = setup(chain);
  const map = new Map<string, ContractInfo>();
  if (!addresses.length) return map;

  const PAGE = 500;
  logger.info(`[${chain}] Fetching contract info for ${addresses.length} addresses…`);

  for (let i = 0; i < addresses.length; i += PAGE) {
    const batch  = addresses.slice(i, i + PAGE);
    const inList = batch.map(a => `'${a}'`).join(',');
    const sql    = `
      SELECT address, bytecode, block_number, CAST(block_timestamp AS VARCHAR) AS block_timestamp
      FROM ${tbl}.contracts
      WHERE address IN (${inList})
    `;
    const rows = await executeQueryAndWait<ContractRow>(sql);
    for (const r of rows) {
      const code = r.bytecode ?? '';
      map.set(r.address.toLowerCase(), {
        bytecode: code.startsWith('0x') ? code.slice(2).toLowerCase() : code.toLowerCase(),
        block_number: r.block_number ?? 0,
        block_timestamp: r.block_timestamp ?? null,
      });
    }
    for (const addr of batch) {
      if (!map.has(addr)) {
        map.set(addr, { bytecode: '', block_number: 0, block_timestamp: null });
      }
    }
    logger.info(`[${chain}] contract-info batch ${i + 1}–${i + batch.length}: ${rows.length} found`);
  }

  return map;
}

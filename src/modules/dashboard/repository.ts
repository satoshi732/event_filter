import {
  getDb,
  ContractAiAuditRow,
  ContractRegistryRow,
  SeenContractRow,
  SeenSelectorEntry,
  getLatestContractAiAudits,
  getLatestTokenAiAudits,
  getContractsRegistry,
  getSeenContractReviewsByPatternHashes,
  getSeenSelectorEntries,
  TokenAiAuditRow,
} from '../../db.js';

export type { ContractAiAuditRow, ContractRegistryRow, SeenContractRow, SeenSelectorEntry, TokenAiAuditRow };

export interface DashboardStoredTokenRow {
  token: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  priceUsd: number | null;
  tokenKind: 'fungible' | 'erc721' | 'erc1155' | 'native' | 'unknown' | null;
  review: string;
  isExploitable: boolean;
  isAutoAudited: boolean;
  isManualAudited: boolean;
  isNative: boolean;
  tokenCreatedAt: string | null;
  tokenCallsSync: boolean | null;
}

export interface DashboardTokenBalanceRow {
  tokenAddress: string;
  contractAddr: string;
  balance: string;
}

export interface DashboardRawRoundRow {
  chain: string;
  blockFrom: number;
  blockTo: number;
  createdAt: string;
}

export interface DashboardRawTransferRow {
  transaction_hash: string;
  from_address: string;
  to_address: string;
  contract_address: string;
  value: string | null;
}

export interface DashboardRawTraceRow {
  transaction_hash: string;
  from_address: string;
  to_address: string;
  value: string;
}

export function getDashboardContractRegistry(
  chain: string,
  addresses: string[],
): Map<string, ContractRegistryRow> {
  return getContractsRegistry(chain, addresses);
}

export function getDashboardContractAutoAnalysis(
  chain: string,
  addresses: string[],
): Map<string, ContractAiAuditRow> {
  return getLatestContractAiAudits(chain, addresses);
}

export function getDashboardTokenAutoAnalysis(
  chain: string,
  addresses: string[],
): Map<string, TokenAiAuditRow> {
  return getLatestTokenAiAudits(chain, addresses);
}

export function getDashboardSeenContractReviews(
  hashes: string[],
): Map<string, SeenContractRow[]> {
  return getSeenContractReviewsByPatternHashes(hashes);
}

export function listDashboardSeenSelectors(): SeenSelectorEntry[] {
  return getSeenSelectorEntries();
}

export function listDashboardContractsRegistry(chain: string): ContractRegistryRow[] {
  const rows = getDb().prepare(`
    SELECT
      id, contract_addr, chain, linkage, link_type, label, review, selector_hash,
      is_exploitable, portfolio, is_auto_audit, is_manual_audit, whitelist_patterns, selectors, code_size,
      deployed_at
    FROM contracts_registry
    WHERE chain = ?
    ORDER BY updated_at DESC, created_at DESC
  `).all(chain.toLowerCase()) as Array<{
    id: string;
    contract_addr: string;
    chain: string;
    deployed_at: string | null;
    linkage: string | null;
    link_type: 'proxy' | 'eip7702' | null;
    label: string;
    review: string;
    selector_hash: string | null;
    is_exploitable: number;
    portfolio: string;
    is_auto_audit: number;
    is_manual_audit: number;
    whitelist_patterns: string;
    selectors: string;
    code_size: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    contractAddr: row.contract_addr.toLowerCase(),
    chain: row.chain,
    deployedAt: row.deployed_at ?? null,
    linkage: row.linkage,
    linkType: row.link_type,
    label: row.label ?? '',
    review: row.review ?? '',
    selectorHash: row.selector_hash,
    isExploitable: Boolean(row.is_exploitable),
    portfolio: row.portfolio ?? '{}',
    isAutoAudit: Boolean(row.is_auto_audit),
    isManualAudit: Boolean(row.is_manual_audit),
    whitelistPatterns: (row.whitelist_patterns ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    selectors: (row.selectors ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    codeSize: row.code_size ?? 0,
  }));
}

export function listDashboardStoredTokens(chain: string): DashboardStoredTokenRow[] {
  const rows = getDb().prepare(`
    SELECT
      address AS token,
      name,
      symbol,
      decimals,
      token_kind,
      price_usd,
      review,
      is_exploitable,
      is_auto_audited,
      is_manual_audited,
      is_native,
      created AS token_created_at,
      calls_sync AS token_calls_sync
    FROM tokens_registry
    WHERE chain = ?
    ORDER BY token ASC
  `).all(chain.toLowerCase()) as Array<{
    token: string;
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    token_kind: string | null;
    price_usd: number | null;
    review: string | null;
    is_exploitable: number;
    is_auto_audited: number;
    is_manual_audited: number;
    is_native: number;
    token_created_at: string | null;
    token_calls_sync: number | null;
  }>;

  return rows.map((row) => ({
    token: row.token.toLowerCase(),
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals ?? null,
    priceUsd: row.price_usd == null ? null : Number(row.price_usd),
    tokenKind: (row.token_kind as DashboardStoredTokenRow['tokenKind']) ?? null,
    review: row.review ?? '',
    isExploitable: Boolean(row.is_exploitable),
    isAutoAudited: Boolean(row.is_auto_audited),
    isManualAudited: Boolean(row.is_manual_audited),
    isNative: Boolean(row.is_native),
    tokenCreatedAt: row.token_created_at ?? null,
    tokenCallsSync: row.token_calls_sync == null ? null : Boolean(row.token_calls_sync),
  }));
}

export function listDashboardTokenBalances(chain: string): DashboardTokenBalanceRow[] {
  const rows = getDb().prepare(`
    SELECT token_address, contract_addr, balance
    FROM token_contract_balances
    WHERE chain = ?
    ORDER BY token_address ASC, contract_addr ASC
  `).all(chain.toLowerCase()) as Array<{
    token_address: string;
    contract_addr: string;
    balance: string;
  }>;

  return rows.map((row) => ({
    tokenAddress: row.token_address.toLowerCase(),
    contractAddr: row.contract_addr.toLowerCase(),
    balance: row.balance ?? '0',
  }));
}

export function listDashboardRawTransfers(chain: string): DashboardRawTransferRow[] {
  return getDb().prepare(`
    SELECT transaction_hash, from_address, to_address, token_address AS contract_address, value
    FROM raw_token_transfers
    WHERE chain = ?
    ORDER BY created_at ASC
  `).all(chain.toLowerCase()) as DashboardRawTransferRow[];
}

export function listDashboardRawTraces(chain: string): DashboardRawTraceRow[] {
  return getDb().prepare(`
    SELECT transaction_hash, from_address, to_address, value
    FROM raw_value_traces
    WHERE chain = ?
    ORDER BY created_at ASC
  `).all(chain.toLowerCase()) as DashboardRawTraceRow[];
}

export function getDashboardLatestRawRound(chain: string): DashboardRawRoundRow | null {
  const row = getDb().prepare(`
    SELECT chain, block_from, block_to, created_at
    FROM raw_rounds
    WHERE chain = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(chain.toLowerCase()) as {
    chain: string;
    block_from: number;
    block_to: number;
    created_at: string;
  } | undefined;

  if (!row) return null;
  return {
    chain: row.chain.toLowerCase(),
    blockFrom: row.block_from,
    blockTo: row.block_to,
    createdAt: row.created_at,
  };
}

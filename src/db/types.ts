export interface PatternRow {
  id: number;
  name: string;
  hex_pattern: string;
  pattern_type: string;
  description: string;
  created_by_username: string;
}

export type TokenKind = 'fungible' | 'erc721' | 'erc1155' | 'native' | 'unknown';

export interface TokenMetadataCacheRow {
  token: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  tokenPriceUsd: number | null;
  tokenKind: TokenKind | null;
  isAutoAudited: boolean;
  isManualAudited: boolean;
  is_native: boolean;
  tokenCreatedAt: string | null;
  tokenCallsSync: boolean | null;
  selectorHash: string | null;
  selectors: string[];
  codeSize: number;
  seenLabel: string;
}

export interface PatternPushQueueRow {
  hash: string;
  label: string;
  selectors: string[];
  bytecodeSize: number;
  createdByUsername: string;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SeenContractRow {
  id: number;
  chain: string;
  contractAddress: string;
  patternHash: string;
  patternKind: string;
  patternAddress: string;
  label: string;
  reviewText: string;
  exploitable: boolean;
  selectors: string[];
  bytecodeSize: number;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PatternSyncStateRow {
  remoteName: string;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastVerifyAt: string | null;
  updatedAt: string;
}

export interface PrimitiveDbSnapshot {
  created_at: string;
  whitelist_patterns: Array<{
    id: number;
    name: string;
    hex_pattern: string;
    pattern_type: string;
    description: string;
    created_by_username: string;
    created_at: string;
  }>;
  seen_selectors: Array<{
    hash: string;
    label: string;
    selectors: string[];
    level: number | null;
    bytecode_size: number;
    created_by_username: string;
    created_at: string;
  }>;
  selectors_temp: Array<{
    id: string;
    chain: string;
    contract_addr: string;
    selector_hash: string;
    selectors: string[];
    label: string;
    bytecode_size: number;
    prepared_by_username: string;
    status: string;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }>;
  tokens_registry: Array<{
    chain: string;
    address: string;
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    token_kind: TokenKind | null;
    price_usd: number | null;
    review: string;
    is_exploitable: number;
    is_auto_audited: number;
    is_manual_audited: number;
    is_native: number;
    created: string | null;
    calls_sync: number | null;
    selector_hash: string | null;
    selectors: string;
    code_size: number;
    seen_label: string;
    updated_at: string;
  }>;
  pattern_sync_state: Array<{
    remote_name: string;
    last_pull_at: string | null;
    last_push_at: string | null;
    last_verify_at: string | null;
    updated_at: string;
  }>;
}

export interface SeenSelectorEntry {
  hash: string;
  label: string;
  selectors: Set<string>;
  level: number | null;
  bytecodeSize: number;
  createdByUsername: string;
}

export interface SelectorTempReviewTarget {
  ownerAddress: string;
  targetAddress: string;
  targetKind: string;
  patternHash: string;
  selectors: string[];
  bytecodeSize: number;
}

export interface RawTransferInput {
  transaction_hash: string;
  from_address: string | null;
  to_address: string | null;
  contract_address: string;
  value: string | null;
}

export interface RawTraceInput {
  transaction_hash: string;
  from_address: string | null;
  to_address: string | null;
  value: string | null;
}

export interface TokenRegistryRow {
  id: string;
  chain: string;
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  tokenKind: TokenKind | null;
  priceUsd: number | null;
  created: string | null;
  callsSync: boolean | null;
  review: string;
  isExploitable: boolean;
  isAutoAudited: boolean;
  isManualAudited: boolean;
  isNative: boolean;
  selectorHash: string | null;
  selectors: string[];
  codeSize: number;
  seenLabel: string;
  updatedAt: string;
}

export interface ContractRegistryRow {
  id: string;
  contractAddr: string;
  chain: string;
  deployedAt: string | null;
  linkage: string | null;
  linkType: 'proxy' | 'eip7702' | null;
  label: string;
  review: string;
  contractSelectorHash: string | null;
  contractSelectors: string[];
  contractCodeSize: number;
  selectorHash: string | null;
  isExploitable: boolean;
  portfolio: string;
  isAutoAudit: boolean;
  isManualAudit: boolean;
  whitelistPatterns: string[];
  selectors: string[];
  codeSize: number;
}

export type AiAuditTargetType = 'contract' | 'token';

export interface BaseAiAuditRow {
  requestSession: string;
  chain: string;
  targetType: AiAuditTargetType;
  targetAddr: string;
  ownerUsername: string | null;
  requestOrigin: 'manual' | 'auto';
  status: 'requested' | 'running' | 'completed' | 'failed';
  title: string;
  provider: string;
  model: string;
  dedaubJobId: string | null;
  analysisSessionId: string | null;
  resultPath: string | null;
  critical: number | null;
  high: number | null;
  medium: number | null;
  isSuccess: boolean | null;
  requestedAt: string;
  auditedAt: string | null;
}

export interface ContractAiAuditRow extends BaseAiAuditRow {
  contractAddr: string;
}

export interface TokenAiAuditRow extends BaseAiAuditRow {
  tokenAddr: string;
}

export interface LegacyTokenMetadataRow {
  chain: string;
  token: string;
  name: string | null;
  symbol: string | null;
  tokenPriceUsd: number | null;
  review?: string;
  isExploitable?: boolean;
  tokenKind?: TokenKind | null;
  isAutoAudited?: boolean;
  isManualAudited?: boolean;
  isNative: boolean;
  tokenCreatedAt: string | null;
  tokenCallsSync: boolean | null;
}

export interface LegacySeenContractRow {
  chain: string;
  contractAddress: string;
  patternHash: string;
  patternKind: string;
  patternAddress: string;
  label: string;
  reviewText: string;
  exploitable: boolean;
  selectors: string[];
  bytecodeSize: number;
  updatedAt: string;
}

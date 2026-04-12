import { groupBySimilarity } from '../../analyzer/scorer.js';
import { buildAddressActivityMap, buildTokenAggs } from '../analysis/token-aggregation.js';
import { getNativeTokenRef, isFungibleTokenKind } from '../../utils/rpc.js';
import { sanitizeTokenPriceUsd } from '../../utils/token-price.js';
import {
  getDefaultAiAuditModel,
  getDefaultAiAuditProvider,
  normalizeAiAuditModel,
  normalizeAiAuditProvider,
} from '../../config.js';
import { PipelineRunResult, TokenResult, TokenContractResult, TokenContractGroup, TokenCounterpartyFlow } from '../../pipeline.js';
import {
  ContractAiAuditRow,
  ContractRegistryRow,
  SeenContractRow,
  DashboardStoredTokenRow,
  getDashboardContractAutoAnalysis,
  getDashboardContractRegistry,
  getDashboardLatestRawRound,
  getDashboardSeenContractReviews,
  getDashboardTokenAutoAnalysis,
  TokenAiAuditRow,
  listDashboardContractsRegistry,
  listDashboardRawTraces,
  listDashboardRawTransfers,
  listDashboardSeenSelectors,
  listDashboardStoredTokens,
  listDashboardTokenBalances,
} from './repository.js';

export interface LatestRunMeta {
  chain: string;
  generated_at: string;
  block_from: number;
  block_to: number;
  token_count: number;
}

export interface DashboardTokenRef {
  token: string;
  token_symbol: string | null;
  token_name: string | null;
}

export interface DashboardTokenSummary {
  chain: string;
  token: string;
  is_native: boolean;
  token_name: string | null;
  token_symbol: string | null;
  decimals: number | null;
  token_price_usd: number | null;
  token_created_at: string | null;
  token_calls_sync: boolean | null;
  auto_audit_status: 'yes' | 'no' | 'processing' | 'failed';
  auto_audit_critical: number | null;
  auto_audit_high: number | null;
  auto_audit_medium: number | null;
  is_auto_audit: boolean;
  is_manual_audit: boolean;
  related_contract_count: number;
  total_transfer_count: number;
  total_transfer_amount: string;
}

export interface DashboardContractSummary {
  contract: string;
  group_kind: 'seen' | 'similar' | 'single';
  group_label: string;
  linkage: string | null;
  portfolio_usd: number | null;
  patterns: string[];
  deployed_at: string | null;
  auto_audit_status: 'yes' | 'no' | 'processing' | 'failed';
  auto_audit_critical: number | null;
  auto_audit_high: number | null;
  auto_audit_medium: number | null;
  is_auto_audit: boolean;
  is_manual_audit: boolean;
  is_seen_pattern: boolean;
  link_type: 'proxy' | 'eip7702' | null;
  label: string;
  token_count: number;
  tokens: DashboardTokenRef[];
  tx_count: number;
  total_token_flow: string;
  is_exploitable: boolean;
  review_count: number;
  selector_hash: string | null;
  code_size: number;
  whitelist_patterns: string[];
}

function deriveAutoAuditStatus(
  registry: { isAutoAudit?: boolean } | { isAutoAudited?: boolean } | undefined,
  audit: ContractAiAuditRow | TokenAiAuditRow | undefined,
): 'yes' | 'no' | 'processing' | 'failed' {
  if (audit?.isSuccess === false) return 'failed';
  if (audit?.auditedAt == null && audit) return 'processing';
  if (audit?.isSuccess === true) return 'yes';
  const autoAudit = (registry as { isAutoAudit?: boolean } | undefined)?.isAutoAudit;
  const autoAudited = (registry as { isAutoAudited?: boolean } | undefined)?.isAutoAudited;
  if (autoAudit || autoAudited) return 'yes';
  return 'no';
}

export function latestRunMeta(run: PipelineRunResult): LatestRunMeta {
  return {
    chain: run.chain,
    generated_at: run.generated_at,
    block_from: run.block_from,
    block_to: run.block_to,
    token_count: run.token_count,
  };
}

export function tokenSummary(token: TokenResult, audit?: TokenAiAuditRow | null): DashboardTokenSummary {
  return {
    chain: token.chain,
    token: token.token,
    is_native: token.is_native,
    token_name: token.token_name,
    token_symbol: token.token_symbol,
    decimals: token.decimals,
    token_price_usd: token.token_price_usd,
    token_created_at: token.token_created_at,
    token_calls_sync: token.token_calls_sync,
    auto_audit_status: deriveAutoAuditStatus({ isAutoAudited: token.is_auto_audit }, audit ?? undefined),
    auto_audit_critical: audit?.critical ?? null,
    auto_audit_high: audit?.high ?? null,
    auto_audit_medium: audit?.medium ?? null,
    is_auto_audit: token.is_auto_audit,
    is_manual_audit: token.is_manual_audit,
    related_contract_count: token.related_contract_count,
    total_transfer_count: token.total_transfer_count,
    total_transfer_amount: token.total_transfer_amount,
  };
}

export function buildDashboardTokens(chain: string, run: PipelineRunResult): DashboardTokenSummary[] {
  const auditMap = getDashboardTokenAutoAnalysis(chain, run.tokens.map((token) => token.token));
  return run.tokens.map((token) => tokenSummary(token, auditMap.get(token.token.toLowerCase()) ?? null));
}

function mapSeenContractReview(row: SeenContractRow) {
  return {
    id: row.id,
    chain: row.chain,
    contract_address: row.contractAddress,
    pattern_hash: row.patternHash,
    pattern_kind: row.patternKind,
    pattern_address: row.patternAddress,
    label: row.label,
    review_text: row.reviewText,
    exploitable: row.exploitable,
    status: row.status,
    updated_at: row.updatedAt,
  };
}

function safeBigInt(value: unknown): bigint {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    if (typeof value === 'string' && value.trim()) return BigInt(value);
    return 0n;
  } catch {
    return 0n;
  }
}

function parsePortfolioUsd(raw: string): number | null {
  if (!raw) return null;

  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;

  try {
    const parsed = JSON.parse(raw) as { total_usd?: unknown; totalUsd?: unknown; usd?: unknown };
    const nested = Number(parsed.total_usd ?? parsed.totalUsd ?? parsed.usd);
    return Number.isFinite(nested) ? nested : null;
  } catch {
    return null;
  }
}

function compareTokenContractsByBalance(a: TokenContractResult, b: TokenContractResult): number {
  const balanceDelta = safeBigInt(b.current_balance) - safeBigInt(a.current_balance);
  if (balanceDelta !== 0n) return balanceDelta > 0n ? 1 : -1;

  const flowDelta = safeBigInt(b.total_token_flow) - safeBigInt(a.total_token_flow);
  if (flowDelta !== 0n) return flowDelta > 0n ? 1 : -1;

  return b.pair_tx_count - a.pair_tx_count;
}

function toStoredTokenSummary(chain: string, token: DashboardStoredTokenRow): TokenResult {
  return {
    chain,
    token: token.token,
    is_native: token.isNative,
    token_name: token.name,
    token_symbol: token.symbol,
    decimals: token.decimals,
    token_price_usd: sanitizeTokenPriceUsd(token.priceUsd),
    token_created_at: token.tokenCreatedAt,
    token_calls_sync: token.tokenCallsSync,
    review: token.review,
    is_exploitable: token.isExploitable,
    is_auto_audit: token.isAutoAudited,
    is_manual_audit: token.isManualAudited,
    related_contract_count: 0,
    total_transfer_count: 0,
    total_transfer_amount: '0',
    groups: [],
  };
}

function buildPatternTargets(
  registry: ContractRegistryRow | undefined,
  contractAddress: string,
  liveSeenLabelByHash: Map<string, string>,
) {
  if (!registry?.selectorHash) return [];

  const seenLabel = liveSeenLabelByHash.get(registry.selectorHash) || undefined;
  const targets: Array<{
    kind: 'contract' | 'implementation' | 'delegate';
    address: string;
    code_size: number;
    pattern_hash: string;
    seen_label?: string;
  }> = [{
    kind: 'contract',
    address: contractAddress,
    code_size: registry.codeSize ?? 0,
    pattern_hash: registry.selectorHash,
    ...(seenLabel ? { seen_label: seenLabel } : {}),
  }];

  if (registry.linkType === 'proxy' && registry.linkage) {
    targets.push({
      kind: 'implementation',
      address: registry.linkage.toLowerCase(),
      code_size: registry.codeSize ?? 0,
      pattern_hash: registry.selectorHash,
      ...(seenLabel ? { seen_label: seenLabel } : {}),
    });
  } else if (registry.linkType === 'eip7702' && registry.linkage) {
    targets.push({
      kind: 'delegate',
      address: registry.linkage.toLowerCase(),
      code_size: registry.codeSize ?? 0,
      pattern_hash: registry.selectorHash,
      ...(seenLabel ? { seen_label: seenLabel } : {}),
    });
  }

  return targets;
}

export function buildPersistedRun(chain: string): PipelineRunResult | null {
  const storedTokens = listDashboardStoredTokens(chain);
  const fungibleStoredTokens = storedTokens.filter((token) => isFungibleTokenKind(token.tokenKind));
  const registryContracts = listDashboardContractsRegistry(chain);
  const allowedTokenSet = new Set(fungibleStoredTokens.map((token) => token.token));
  const balanceRows = listDashboardTokenBalances(chain).filter((row) => allowedTokenSet.has(row.tokenAddress));
  const transfers = listDashboardRawTransfers(chain);
  const traces = listDashboardRawTraces(chain);
  const latestRound = getDashboardLatestRawRound(chain);

  if (
    !fungibleStoredTokens.length
    && !registryContracts.length
    && !balanceRows.length
    && !transfers.length
    && !traces.length
  ) {
    return null;
  }

  const liveSeenLabelByHash = new Map(
    listDashboardSeenSelectors().map((entry) => [entry.hash, entry.label]),
  );
  const reviewHashes = [...new Set(registryContracts.map((row) => row.selectorHash).filter(Boolean) as string[])];
  const reviewMap = getDashboardSeenContractReviews(reviewHashes);
  const contractRegistryMap = new Map(registryContracts.map((row) => [row.contractAddr, row]));
  const candidateContracts = new Set(registryContracts.map((row) => row.contractAddr));
  const pseudoContractInfos = new Map(
    [...candidateContracts].map((address) => [address, { address, bytecode: '0x01' }]),
  );
  const addrActivity = buildAddressActivityMap(transfers, traces);
  const tokenAggs = buildTokenAggs(chain, transfers, traces, candidateContracts, pseudoContractInfos as never);
  for (const token of [...tokenAggs.keys()]) {
    if (!allowedTokenSet.has(token)) tokenAggs.delete(token);
  }
  const balanceMap = new Map(balanceRows.map((row) => [`${row.tokenAddress}:${row.contractAddr}`, row.balance ?? '0']));
  const tokenSeedMap = new Map(fungibleStoredTokens.map((row) => [row.token, row]));
  const tokenContractIndex = new Map<string, Set<string>>();

  for (const [token, agg] of tokenAggs.entries()) {
    tokenContractIndex.set(token, new Set(agg.contracts.keys()));
  }
  for (const row of balanceRows) {
    const set = tokenContractIndex.get(row.tokenAddress) ?? new Set<string>();
    set.add(row.contractAddr);
    tokenContractIndex.set(row.tokenAddress, set);

    const tokenAgg = tokenAggs.get(row.tokenAddress) ?? {
      token: row.tokenAddress,
      total_transfer_count: 0,
      total_transfer_amount: 0n,
      contracts: new Map(),
    };
    if (!tokenAgg.contracts.has(row.contractAddr)) {
      tokenAgg.contracts.set(row.contractAddr, {
        contract: row.contractAddr,
        transfer_in_count: 0,
        transfer_in_amount: 0n,
        transfer_out_count: 0,
        transfer_out_amount: 0n,
        tx_hashes: new Set(),
        counterparties: new Map(),
      });
    }
    tokenAggs.set(row.tokenAddress, tokenAgg);
  }
  for (const token of tokenSeedMap.keys()) {
    if (!tokenAggs.has(token)) {
      tokenAggs.set(token, {
        token,
        total_transfer_count: 0,
        total_transfer_amount: 0n,
        contracts: new Map(),
      });
    }
  }

  const tokens: TokenResult[] = [...tokenAggs.keys()].sort().map((token) => {
    const tokenAgg = tokenAggs.get(token)!;
    const tokenSeed = tokenSeedMap.get(token) ?? {
      token,
      name: null,
      symbol: null,
      decimals: null,
      priceUsd: null,
      tokenKind: null,
      review: '',
      isExploitable: false,
      isAutoAudited: false,
      isManualAudited: false,
      isNative: token === getNativeTokenRef(chain),
      tokenCreatedAt: null,
      tokenCallsSync: null,
    };
    const contractAddresses = [...(tokenContractIndex.get(token) ?? new Set(tokenAgg.contracts.keys()))];
    const contracts: TokenContractResult[] = contractAddresses.map((contractAddr) => {
      const pairAgg = tokenAgg.contracts.get(contractAddr) ?? {
        contract: contractAddr,
        transfer_in_count: 0,
        transfer_in_amount: 0n,
        transfer_out_count: 0,
        transfer_out_amount: 0n,
        tx_hashes: new Set<string>(),
        counterparties: new Map(),
      };
      const registry = contractRegistryMap.get(contractAddr);
      const patternTargets = buildPatternTargets(registry, contractAddr, liveSeenLabelByHash);
      const selectorHash = registry?.selectorHash ?? null;
      const seenLabel = selectorHash ? liveSeenLabelByHash.get(selectorHash) : undefined;
      const reviews = selectorHash
        ? (reviewMap.get(selectorHash) ?? [])
          .filter((entry) =>
            entry.chain === chain.toLowerCase()
            && entry.contractAddress === contractAddr.toLowerCase(),
          )
          .map(mapSeenContractReview)
        : [];
      const activity = addrActivity.get(contractAddr);
      const flowBreakdown = [...pairAgg.counterparties.values()]
        .map((counterparty) => ({
          address: counterparty.address,
          label: counterparty.label,
          is_contract: counterparty.is_contract,
          transfer_in_count: counterparty.transfer_in_count,
          transfer_in_amount: counterparty.transfer_in_amount.toString(),
          transfer_out_count: counterparty.transfer_out_count,
          transfer_out_amount: counterparty.transfer_out_amount.toString(),
          tx_count: counterparty.tx_hashes.size,
          total_flow: (counterparty.transfer_in_amount + counterparty.transfer_out_amount).toString(),
        }))
        .sort((a, b) => {
          if (a.is_contract !== b.is_contract) return a.is_contract ? -1 : 1;
          const delta = safeBigInt(b.total_flow) - safeBigInt(a.total_flow);
          if (delta !== 0n) return delta > 0n ? 1 : -1;
          return b.tx_count - a.tx_count;
        });
      return {
        contract: contractAddr,
        xfer_out: activity?.xfer_out ?? 0,
        xfer_in: activity?.xfer_in ?? 0,
        eth_out: (activity?.eth_out ?? 0n).toString(),
        eth_in: (activity?.eth_in ?? 0n).toString(),
        tx_count: activity?.tx_hashes.size ?? pairAgg.tx_hashes.size,
        ...(registry?.linkType === 'proxy' && registry.linkage ? { proxy_impl: registry.linkage } : {}),
        ...(registry?.linkType === 'eip7702' && registry.linkage ? { eip7702_delegate: registry.linkage } : {}),
        matched_whitelist: registry?.whitelistPatterns?.length
          ? registry.whitelistPatterns
          : [],
        selectors: registry?.selectors ?? [],
        selector_hash: selectorHash,
        code_size: registry?.codeSize ?? 0,
        ...(seenLabel ? { seen_label: seenLabel } : {}),
        transfer_in_count: pairAgg.transfer_in_count,
        transfer_in_amount: pairAgg.transfer_in_amount.toString(),
        transfer_out_count: pairAgg.transfer_out_count,
        transfer_out_amount: pairAgg.transfer_out_amount.toString(),
        pair_tx_count: pairAgg.tx_hashes.size,
        current_balance: balanceMap.get(`${token}:${contractAddr}`) ?? '0',
        total_token_flow: (pairAgg.transfer_in_amount + pairAgg.transfer_out_amount).toString(),
        flow_breakdown: flowBreakdown,
        created_at: registry?.deployedAt ?? null,
        pattern_targets: patternTargets,
        reviews,
        is_exploitable: Boolean(registry?.isExploitable) || reviews.some((row) => row.exploitable),
        is_auto_audit: registry?.isAutoAudit ?? false,
        is_manual_audit: registry?.isManualAudit ?? false,
      };
    }).sort(compareTokenContractsByBalance);

    const groups: TokenContractGroup[] = groupBySimilarity(contracts).map((group) => ({
      id: group.id,
      kind: group.kind,
      label: group.label,
      contract_count: group.members.length,
      total_transfer_amount: group.members
        .reduce((acc, row) => acc + safeBigInt(row.total_token_flow), 0n)
        .toString(),
      contracts: [...group.members].sort(compareTokenContractsByBalance),
    }));

    const summary = toStoredTokenSummary(chain, tokenSeed);
    return {
      ...summary,
      related_contract_count: contracts.length,
      total_transfer_count: tokenAgg.total_transfer_count,
      total_transfer_amount: tokenAgg.total_transfer_amount.toString(),
      groups,
    };
  });

  return {
    chain,
    generated_at: latestRound?.createdAt ?? new Date().toISOString(),
    block_from: latestRound?.blockFrom ?? 0,
    block_to: latestRound?.blockTo ?? 0,
    token_count: tokens.length,
    tokens,
  };
}

export function latestPersistedRunMeta(chain: string): LatestRunMeta | null {
  const round = getDashboardLatestRawRound(chain);
  if (!round) return null;
  return {
    chain,
    generated_at: round.createdAt,
    block_from: round.blockFrom,
    block_to: round.blockTo,
    token_count: listDashboardStoredTokens(chain).filter((token) => isFungibleTokenKind(token.tokenKind)).length,
  };
}

interface LiveReviewContext {
  liveSeenLabelByHash: Map<string, string>;
  reviewMap: ReturnType<typeof getDashboardSeenContractReviews>;
  registryMap: ReturnType<typeof getDashboardContractRegistry>;
  autoAnalysisMap: ReturnType<typeof getDashboardContractAutoAnalysis>;
}

function buildLiveReviewContext(chain: string, tokens: TokenResult[]): LiveReviewContext {
  const liveSeenLabelByHash = new Map(
    listDashboardSeenSelectors().map((entry) => [entry.hash, entry.label]),
  );
  const reviewHashes = new Set<string>();
  const contractAddresses = new Set<string>();
  for (const token of tokens) {
    for (const group of token.groups) {
      for (const contract of group.contracts) {
        contractAddresses.add(contract.contract.toLowerCase());
        for (const target of contract.pattern_targets ?? []) {
          reviewHashes.add(target.pattern_hash);
        }
      }
    }
  }

  return {
    liveSeenLabelByHash,
    reviewMap: getDashboardSeenContractReviews([...reviewHashes]),
    registryMap: getDashboardContractRegistry(chain, [...contractAddresses]),
    autoAnalysisMap: getDashboardContractAutoAnalysis(chain, [...contractAddresses]),
  };
}

function applyLiveReviewsToToken(
  chain: string,
  token: TokenResult,
  context: LiveReviewContext,
): TokenResult {
  const {
    liveSeenLabelByHash,
    reviewMap,
    registryMap,
    autoAnalysisMap,
  } = context;

  const refreshedContracts = token.groups.flatMap((group) => group.contracts.map((contract) => {
    const normalizedAddress = contract.contract.toLowerCase();
    const registry = registryMap.get(normalizedAddress);
    const autoAnalysis = autoAnalysisMap.get(normalizedAddress);
    const selectorHash = registry?.selectorHash
      ?? contract.selector_hash
      ?? contract.pattern_targets?.[0]?.pattern_hash
      ?? null;
    const patternTargets = (contract.pattern_targets ?? []).map((target) => {
      const liveSeenLabel = liveSeenLabelByHash.get(target.pattern_hash);
      if (!liveSeenLabel || target.seen_label === liveSeenLabel) return target;
      return { ...target, seen_label: liveSeenLabel };
    });

    const reviews = patternTargets.flatMap((target) =>
      (reviewMap.get(target.pattern_hash) ?? [])
        .filter((entry) =>
          entry.chain === chain.toLowerCase()
          && entry.contractAddress === contract.contract.toLowerCase(),
        )
        .map(mapSeenContractReview),
    );

    const seenLabel = selectorHash ? liveSeenLabelByHash.get(selectorHash) : undefined;
    const nextContract = {
      ...contract,
      selector_hash: selectorHash,
      selectors: registry?.selectors ?? contract.selectors ?? [],
      whitelist_patterns: registry?.whitelistPatterns?.length
        ? registry.whitelistPatterns
        : (contract.matched_whitelist ?? []),
      pattern_targets: patternTargets,
      reviews,
      is_seen_pattern: Boolean(seenLabel) || patternTargets.some((target) => Boolean(target.seen_label)),
      is_exploitable: Boolean(registry?.isExploitable) || reviews.some((item) => item.exploitable),
      is_auto_audit: registry?.isAutoAudit ?? contract.is_auto_audit ?? false,
      is_manual_audit: registry?.isManualAudit ?? contract.is_manual_audit ?? false,
      auto_audit_status: deriveAutoAuditStatus(registry, autoAnalysis),
      auto_audit_critical: autoAnalysis?.critical ?? null,
      auto_audit_high: autoAnalysis?.high ?? null,
      auto_audit_medium: autoAnalysis?.medium ?? null,
    } as typeof contract & {
      selector_hash: string | null;
      is_auto_audit: boolean;
      is_manual_audit: boolean;
      auto_audit_status: 'yes' | 'no' | 'processing' | 'failed';
      auto_audit_critical: number | null;
      auto_audit_high: number | null;
      auto_audit_medium: number | null;
    };

    if (seenLabel) return { ...nextContract, seen_label: seenLabel };

    const { seen_label: _droppedSeenLabel, ...rest } = nextContract as typeof nextContract & { seen_label?: string };
    return rest;
  }));

  return {
    ...token,
    groups: groupBySimilarity(refreshedContracts).map((group) => ({
      id: group.id,
      kind: group.kind,
      label: group.label,
      contract_count: group.members.length,
      total_transfer_amount: group.members
        .reduce((acc, row) => acc + safeBigInt(row.total_token_flow), 0n)
        .toString(),
      contracts: [...group.members].sort(compareTokenContractsByBalance),
    })),
  };
}

export function withLiveReviews(chain: string, token: TokenResult): TokenResult {
  return applyLiveReviewsToToken(chain, token, buildLiveReviewContext(chain, [token]));
}

function resolveRegistryContractSummary(
  registry: ContractRegistryRow | undefined,
  source: {
    label: string;
    linkType: 'proxy' | 'eip7702' | null;
    linkage: string | null;
    deployedAt: string | null;
    isExploitable: boolean;
    selectorHash: string | null;
    codeSize: number;
    whitelist: Set<string>;
  },
) {
  return {
    label: registry?.label || source.label,
    link_type: registry?.linkType ?? source.linkType,
    linkage: registry?.linkage ?? source.linkage,
    portfolio_usd: registry ? parsePortfolioUsd(registry.portfolio) : null,
    deployed_at: registry?.deployedAt ?? source.deployedAt,
    is_exploitable: registry?.isExploitable ?? source.isExploitable,
    selector_hash: registry?.selectorHash ?? source.selectorHash,
    code_size: registry?.codeSize ?? source.codeSize,
    whitelist_patterns: registry?.whitelistPatterns?.length
      ? registry.whitelistPatterns
      : [...source.whitelist],
    is_auto_audit: registry?.isAutoAudit ?? false,
    is_manual_audit: registry?.isManualAudit ?? false,
  };
}

export function buildDashboardContracts(chain: string, run: PipelineRunResult): DashboardContractSummary[] {
  const liveReviewContext = buildLiveReviewContext(chain, run.tokens);
  const acc = new Map<string, {
    contract: string;
    groupKind: 'seen' | 'similar' | 'single';
    groupLabel: string;
    label: string;
    linkType: 'proxy' | 'eip7702' | null;
    linkage: string | null;
    deployedAt: string | null;
    tokenMap: Map<string, DashboardTokenRef>;
    txCount: number;
    totalTokenFlow: bigint;
    isExploitable: boolean;
    reviewIds: Set<string>;
    isSeenPattern: boolean;
    selectorHash: string | null;
    codeSize: number;
    whitelist: Set<string>;
  }>();

  for (const tokenEntry of run.tokens) {
    const token = applyLiveReviewsToToken(chain, tokenEntry, liveReviewContext);
    const tokenRef: DashboardTokenRef = {
      token: token.token,
      token_symbol: token.token_symbol,
      token_name: token.token_name,
    };

    for (const group of token.groups) {
      for (const contract of group.contracts) {
        const address = contract.contract.toLowerCase();
        const nextGroupRank = group.kind === 'seen' ? 3 : (group.kind === 'similar' ? 2 : 1);
        const current = acc.get(address) ?? {
          contract: address,
          groupKind: group.kind,
          groupLabel: group.label,
          label: contract.seen_label ?? '',
          linkType: contract.proxy_impl ? 'proxy' : (contract.eip7702_delegate ? 'eip7702' : null),
          linkage: contract.proxy_impl ?? contract.eip7702_delegate ?? null,
          deployedAt: contract.created_at ?? null,
          tokenMap: new Map<string, DashboardTokenRef>(),
          txCount: 0,
          totalTokenFlow: 0n,
          isExploitable: false,
          reviewIds: new Set<string>(),
          isSeenPattern: Boolean(contract.is_seen_pattern) || Boolean(contract.seen_label),
          selectorHash: contract.pattern_targets?.[0]?.pattern_hash ?? null,
          codeSize: contract.code_size ?? 0,
          whitelist: new Set<string>(),
        };

        const currentGroupRank = current.groupKind === 'seen' ? 3 : (current.groupKind === 'similar' ? 2 : 1);
        if (nextGroupRank > currentGroupRank) {
          current.groupKind = group.kind;
          current.groupLabel = group.label;
        }
        current.tokenMap.set(tokenRef.token, tokenRef);
        current.txCount = Math.max(current.txCount, contract.tx_count ?? 0);
        current.totalTokenFlow += safeBigInt(contract.total_token_flow);
        current.isExploitable = current.isExploitable || Boolean(contract.is_exploitable);
        current.isSeenPattern = current.isSeenPattern || Boolean(contract.is_seen_pattern) || Boolean(contract.seen_label);
        if (!current.label && contract.seen_label) current.label = contract.seen_label;
        if (!current.selectorHash && contract.pattern_targets?.length) {
          current.selectorHash = contract.pattern_targets[0]?.pattern_hash ?? null;
        }
        current.codeSize = Math.max(current.codeSize, contract.code_size ?? 0);
        current.deployedAt = current.deployedAt ?? contract.created_at ?? null;

        for (const pattern of contract.matched_whitelist ?? []) {
          current.whitelist.add(pattern);
        }
        for (const review of contract.reviews ?? []) {
          const key = `${review.id}:${review.pattern_hash}:${review.updated_at}`;
          current.reviewIds.add(key);
        }

        acc.set(address, current);
      }
    }
  }

  const addresses = [...acc.keys()];
  const registryMap = getDashboardContractRegistry(chain, addresses);
  const autoAnalysisMap = getDashboardContractAutoAnalysis(chain, addresses);

  const rows = addresses.map((address) => {
    const source = acc.get(address)!;
    const registry = registryMap.get(address);
    const autoAnalysis = autoAnalysisMap.get(address);
    const resolved = resolveRegistryContractSummary(registry, source);
    return {
      contract: address,
      group_kind: source.groupKind,
      group_label: source.groupLabel,
      linkage: resolved.linkage,
      portfolio_usd: resolved.portfolio_usd,
      patterns: resolved.whitelist_patterns,
      deployed_at: resolved.deployed_at,
      auto_audit_status: deriveAutoAuditStatus(registry, autoAnalysis),
      auto_audit_critical: autoAnalysis?.critical ?? null,
      auto_audit_high: autoAnalysis?.high ?? null,
      auto_audit_medium: autoAnalysis?.medium ?? null,
      is_auto_audit: resolved.is_auto_audit,
      is_manual_audit: resolved.is_manual_audit,
      is_seen_pattern: source.isSeenPattern,
      label: resolved.label,
      link_type: resolved.link_type,
      token_count: source.tokenMap.size,
      tokens: [...source.tokenMap.values()],
      tx_count: source.txCount,
      total_token_flow: source.totalTokenFlow.toString(),
      is_exploitable: resolved.is_exploitable,
      review_count: source.reviewIds.size,
      selector_hash: resolved.selector_hash,
      code_size: resolved.code_size,
      whitelist_patterns: resolved.whitelist_patterns,
    };
  });

  return rows.sort((a, b) => {
    const usdDelta = (b.portfolio_usd ?? -1) - (a.portfolio_usd ?? -1);
    if (usdDelta !== 0) return usdDelta > 0 ? 1 : -1;

    const flowDelta = safeBigInt(b.total_token_flow) - safeBigInt(a.total_token_flow);
    if (flowDelta !== 0n) return flowDelta > 0n ? 1 : -1;

    return b.tx_count - a.tx_count;
  });
}

export function buildContractDetail(chain: string, run: PipelineRunResult, contractAddress: string) {
  const liveReviewContext = buildLiveReviewContext(chain, run.tokens);
  const target = contractAddress.toLowerCase();
  const tokenRows: Array<{
    token: ReturnType<typeof tokenSummary>;
    group_kind: string;
    group_label: string;
    selector_hash: string | null;
    is_manual_audit: boolean;
    transfer_in_count: number;
    transfer_in_amount: string;
    transfer_out_count: number;
    transfer_out_amount: string;
    pair_tx_count: number;
    current_balance: string | null;
    total_token_flow: string;
    flow_breakdown: TokenCounterpartyFlow[];
  }> = [];

  const patternTargetMap = new Map<string, {
    kind: string;
    address: string;
    code_size: number;
    pattern_hash: string;
    seen_label?: string;
  }>();
  const reviewsMap = new Map<string, {
    id: number;
    chain: string;
    contract_address: string;
    pattern_hash: string;
    pattern_kind: string;
    pattern_address: string;
    label: string;
    review_text: string;
    exploitable: boolean;
    status: string;
    updated_at: string;
  }>();

  let totalInCount = 0;
  let totalOutCount = 0;
  let totalPairTx = 0;
  let totalFlow = 0n;
  let txCount = 0;
  let seenLabel = '';
  let linkType: 'proxy' | 'eip7702' | null = null;
  let linkage: string | null = null;
  let codeSize = 0;
  let selectorHash: string | null = null;
  let isExploitable = false;
  const whitelistPatterns = new Set<string>();

  for (const rawToken of run.tokens) {
    const token = applyLiveReviewsToToken(chain, rawToken, liveReviewContext);
    for (const group of token.groups) {
      for (const contract of group.contracts) {
        if (contract.contract.toLowerCase() !== target) continue;

        tokenRows.push({
          token: tokenSummary(token),
          group_kind: group.kind,
          group_label: group.label,
          selector_hash: contract.selector_hash ?? contract.pattern_targets?.[0]?.pattern_hash ?? null,
          is_manual_audit: contract.is_manual_audit ?? false,
          transfer_in_count: contract.transfer_in_count,
          transfer_in_amount: contract.transfer_in_amount,
          transfer_out_count: contract.transfer_out_count,
          transfer_out_amount: contract.transfer_out_amount,
          pair_tx_count: contract.pair_tx_count,
          current_balance: contract.current_balance,
          total_token_flow: contract.total_token_flow,
          flow_breakdown: contract.flow_breakdown ?? [],
        });

        totalInCount += contract.transfer_in_count;
        totalOutCount += contract.transfer_out_count;
        totalPairTx += contract.pair_tx_count;
        totalFlow += safeBigInt(contract.total_token_flow);
        txCount = Math.max(txCount, contract.tx_count ?? 0);
        codeSize = Math.max(codeSize, contract.code_size ?? 0);
        if (!seenLabel && contract.seen_label) seenLabel = contract.seen_label;
        if (!selectorHash && contract.pattern_targets?.length) {
          selectorHash = contract.pattern_targets[0]?.pattern_hash ?? null;
        }

        const nextLinkType: 'proxy' | 'eip7702' | null = contract.proxy_impl
          ? 'proxy'
          : (contract.eip7702_delegate ? 'eip7702' : null);
        linkType = linkType ?? nextLinkType;
        linkage = linkage ?? contract.proxy_impl ?? contract.eip7702_delegate ?? null;

        for (const targetItem of contract.pattern_targets ?? []) {
          const key = `${targetItem.kind}:${targetItem.address}:${targetItem.pattern_hash}`;
          patternTargetMap.set(key, targetItem);
        }
        for (const review of contract.reviews ?? []) {
          const key = `${review.id}:${review.pattern_hash}:${review.updated_at}`;
          reviewsMap.set(key, review);
        }
        const contractWhitelistPatterns = (contract as TokenContractResult & { whitelist_patterns?: string[] }).whitelist_patterns;
        for (const pattern of contractWhitelistPatterns ?? contract.matched_whitelist ?? []) {
          whitelistPatterns.add(pattern);
        }
        isExploitable = isExploitable || Boolean(contract.is_exploitable);
      }
    }
  }

  if (!tokenRows.length) return null;

  tokenRows.sort((a, b) => {
    const flowDelta = safeBigInt(b.total_token_flow) - safeBigInt(a.total_token_flow);
    if (flowDelta !== 0n) return flowDelta > 0n ? 1 : -1;
    return b.pair_tx_count - a.pair_tx_count;
  });

  const registry = getDashboardContractRegistry(chain, [target]).get(target);
  const autoAnalysis = getDashboardContractAutoAnalysis(chain, [target]).get(target) ?? null;

  return {
    address: target,
    chain,
    label: registry?.label || seenLabel,
    link_type: registry?.linkType ?? linkType,
    linkage: registry?.linkage ?? linkage,
    selector_hash: registry?.selectorHash ?? selectorHash,
    code_size: registry?.codeSize ?? codeSize,
    selectors: registry?.selectors ?? [],
    review: registry?.review ?? '',
    is_exploitable: registry?.isExploitable ?? isExploitable,
    is_auto_audit: registry?.isAutoAudit ?? false,
    is_manual_audit: registry?.isManualAudit ?? false,
    auto_analysis: autoAnalysis ? {
      request_session: autoAnalysis.requestSession,
      title: autoAnalysis.title,
      provider: normalizeAiAuditProvider(autoAnalysis.provider),
      model: normalizeAiAuditModel(autoAnalysis.provider, autoAnalysis.model),
      status: autoAnalysis.auditedAt
        ? (autoAnalysis.isSuccess === false ? 'failed' : 'completed')
        : 'requested',
      requested_at: autoAnalysis.requestedAt,
      completed_at: autoAnalysis.auditedAt,
      critical: autoAnalysis.critical,
      high: autoAnalysis.high,
      medium: autoAnalysis.medium,
      report_path: autoAnalysis.resultPath,
      error: autoAnalysis.isSuccess === false ? 'audit failed' : null,
    } : {
      request_session: null,
      title: 'AI Auto Audit',
      provider: getDefaultAiAuditProvider(),
      model: getDefaultAiAuditModel(getDefaultAiAuditProvider()),
      status: 'idle',
      requested_at: null,
      completed_at: null,
      critical: null,
      high: null,
      medium: null,
      report_path: null,
      error: null,
    },
    whitelist_patterns: registry?.whitelistPatterns?.length
      ? registry.whitelistPatterns
      : [...whitelistPatterns],
    portfolio_usd: registry ? parsePortfolioUsd(registry.portfolio) : null,
    activity: {
      token_count: tokenRows.length,
      tx_count: txCount,
      transfer_in_count: totalInCount,
      transfer_out_count: totalOutCount,
      pair_tx_count: totalPairTx,
      total_token_flow: totalFlow.toString(),
    },
    pattern_targets: [...patternTargetMap.values()],
    reviews: [...reviewsMap.values()],
    tokens: tokenRows,
  };
}

import { classifyDelegations } from './utils/proxy.js';
import {
  SeenContractRow,
  getWhitelistPatterns,
  getSeenContractReviewsByPatternHashes,
  getSeenSelectorEntries,
  getTokenMetadataCache,
  getTokensMissingPrice,
  upsertTokenContractFactsBatch,
  upsertTokenPriceBatch,
} from './db.js';
import {
  getDelegateCalls,
  getContractInfos,
  ContractInfo,
} from './chainbase/queries.js';
import { extractSelectors } from './analyzer/bytecode.js';
import { groupBySimilarity, scoreContract, ScoredResult } from './analyzer/scorer.js';
import { logger } from './utils/logger.js';
import { sanitizeTokenPriceUsd } from './utils/token-price.js';
import { getChainConfig } from './config.js';
import {
  getNativeTokenRef,
  getTokenBalancesBatch,
  getTokenMetadataBatch,
  getTokenPricesBatch,
  isFungibleTokenKind,
  TokenMetadata,
} from './utils/rpc.js';
import { collectRawRoundSnapshot } from './modules/raw-data/index.js';
import { resolvePatternHash, safeBigInt, detectSyncCallPattern } from './modules/analysis/index.js';
import {
  backfillContractDeployments,
  backfillContractPatternMetadata,
  getKnownContractMap,
  getKnownContractSet,
  persistNewContracts,
  updateRoundPortfolio,
} from './modules/contract-manager/index.js';
import { syncTokenRegistryForRound } from './modules/token-manager/index.js';
import { persistTokenContractBalances } from './modules/info-manager/index.js';
import { buildAddressActivityMap, buildTokenAggs, TokenAgg } from './modules/analysis/token-aggregation.js';
import { matchSeenEntryBySimilarity } from './modules/selectors-manager/index.js';

export interface TokenContractResult extends ScoredResult {
  selector_hash?: string | null;
  transfer_in_count: number;
  transfer_in_amount: string;
  transfer_out_count: number;
  transfer_out_amount: string;
  pair_tx_count: number;
  current_balance: string | null;
  total_token_flow: string;
  flow_breakdown: TokenCounterpartyFlow[];
  created_at: string | null;
  pattern_targets: PatternTargetInfo[];
  reviews: ContractReviewInfo[];
  is_exploitable: boolean;
  is_seen_pattern?: boolean;
  is_auto_audit?: boolean;
  is_manual_audit?: boolean;
}

export interface PatternTargetInfo {
  kind: 'contract' | 'implementation' | 'delegate';
  address: string;
  code_size: number;
  pattern_hash: string;
  seen_label?: string;
}

export interface ContractReviewInfo {
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
}

export interface TokenContractGroup {
  id: string;
  kind: 'seen' | 'similar' | 'single';
  label: string;
  contract_count: number;
  total_transfer_amount: string;
  contracts: TokenContractResult[];
}

export interface TokenResult {
  chain: string;
  token: string;
  is_native: boolean;
  token_name: string | null;
  token_symbol: string | null;
  decimals: number | null;
  token_price_usd: number | null;
  token_created_at: string | null;
  token_calls_sync: boolean | null;
  review?: string;
  is_exploitable?: boolean;
  is_auto_audit: boolean;
  is_manual_audit: boolean;
  related_contract_count: number;
  total_transfer_count: number;
  total_transfer_amount: string;
  groups: TokenContractGroup[];
}

export interface PipelineRunResult {
  chain: string;
  generated_at: string;
  block_from: number;
  block_to: number;
  token_count: number;
  tokens: TokenResult[];
}

export interface PipelineProgressUpdate {
  chain: string;
  stage:
    | 'boot'
    | 'raw-data'
    | 'contract-info'
    | 'delegations'
    | 'contract-analysis'
    | 'portfolio'
    | 'token-sync'
    | 'finalize'
    | 'complete'
    | 'failed';
  label: string;
  percent: number;
  current?: number;
  total?: number;
  detail?: string;
  updated_at: string;
}

export interface RunPipelineOptions {
  onProgress?: (update: PipelineProgressUpdate) => void;
}

export interface TokenCounterpartyFlow {
  address: string | null;
  label: string;
  is_contract: boolean;
  transfer_in_count: number;
  transfer_in_amount: string;
  transfer_out_count: number;
  transfer_out_amount: string;
  tx_count: number;
  total_flow: string;
}

interface RankedTokenContractGroup extends TokenContractGroup {
  max_balance: string;
}

interface TokenContractFacts {
  tokenCreatedAt: string | null;
  tokenCallsSync: boolean | null;
}

const TOKEN_PRICE_BACKFILL_BATCH_SIZE = 300;
const CONTRACT_ANALYSIS_PROGRESS_STEP = 25;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function createProgressEmitter(
  chain: string,
  onProgress?: (update: PipelineProgressUpdate) => void,
) {
  return (update: Omit<PipelineProgressUpdate, 'chain' | 'updated_at'>) => {
    onProgress?.({
      ...update,
      chain,
      percent: clampPercent(update.percent),
      updated_at: new Date().toISOString(),
    });
  };
}

function compareTokenContractsByBalance(a: TokenContractResult, b: TokenContractResult): number {
  const balanceDelta = safeBigInt(b.current_balance) - safeBigInt(a.current_balance);
  if (balanceDelta !== 0n) return balanceDelta > 0n ? 1 : -1;

  const flowDelta = safeBigInt(b.total_token_flow) - safeBigInt(a.total_token_flow);
  if (flowDelta !== 0n) return flowDelta > 0n ? 1 : -1;

  return b.pair_tx_count - a.pair_tx_count;
}

function normalizeSelectorList(selectors: string[]): string[] {
  return [...new Set((selectors ?? []).map((value) => value.toLowerCase()))].sort();
}

function selectorListsEqual(left: string[], right: string[]): boolean {
  const a = normalizeSelectorList(left);
  const b = normalizeSelectorList(right);
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function primaryPatternTarget(targets: PatternTargetInfo[]): PatternTargetInfo | null {
  return targets.find((target) => target.kind !== 'contract')
    ?? targets.find((target) => target.kind === 'contract')
    ?? null;
}

function mapSeenContractReview(row: SeenContractRow): ContractReviewInfo {
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

function decimalBalanceToFloat(rawValue: string | null, decimals: number | null, precision = 8): number {
  if (rawValue == null) return 0;
  if (!/^\d+$/.test(rawValue)) return 0;
  const normalized = rawValue.replace(/^0+/, '') || '0';
  const safeDecimals = Math.max(0, decimals ?? 0);

  if (safeDecimals === 0) {
    const direct = Number(normalized);
    return Number.isFinite(direct) ? direct : 0;
  }

  const fractionDigits = Math.max(0, Math.min(precision, safeDecimals));
  const whole = normalized.length > safeDecimals
    ? normalized.slice(0, normalized.length - safeDecimals)
    : '0';
  const fractionSource = normalized.length > safeDecimals
    ? normalized.slice(normalized.length - safeDecimals)
    : normalized.padStart(safeDecimals, '0');
  const fraction = fractionDigits > 0
    ? fractionSource.slice(0, fractionDigits).padEnd(fractionDigits, '0')
    : '';

  const direct = Number(fraction ? `${whole}.${fraction}` : whole);
  return Number.isFinite(direct) ? direct : 0;
}

function computeContractPortfolioUsd(input: {
  contractAddresses: string[];
  tokenAggs: Map<string, TokenAgg>;
  tokenMetadataMap: Map<string, TokenMetadata>;
  balanceMap: Map<string, string | null>;
}): Map<string, number> {
  const totals = new Map<string, number>();
  for (const address of input.contractAddresses) {
    totals.set(address.toLowerCase(), 0);
  }

  for (const [token, tokenAgg] of input.tokenAggs.entries()) {
    const metadata = input.tokenMetadataMap.get(token);
    const decimals = metadata?.decimals ?? null;
    const priceUsd = sanitizeTokenPriceUsd(metadata?.priceUsd ?? null);
    if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) continue;

    for (const contractAddr of tokenAgg.contracts.keys()) {
      const key = `${token}:${contractAddr}`;
      const balance = input.balanceMap.get(key) ?? null;
      const tokenAmount = decimalBalanceToFloat(balance, decimals);
      if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) continue;

      const current = totals.get(contractAddr.toLowerCase()) ?? 0;
      totals.set(contractAddr.toLowerCase(), current + (tokenAmount * priceUsd));
    }
  }

  return totals;
}

export async function runPipeline(
  chain: string,
  options: RunPipelineOptions = {},
): Promise<PipelineRunResult> {
  const emitProgress = createProgressEmitter(chain, options.onProgress);
  logger.hr();
  logger.info(`[${chain}] Pipeline round started`);
  emitProgress({
    stage: 'boot',
    label: 'Starting pipeline round',
    percent: 2,
  });

  const chainConfig = getChainConfig(chain);
  emitProgress({
    stage: 'raw-data',
    label: 'Collecting raw transfer and trace data',
    percent: 6,
  });
  const rawRound = await collectRawRoundSnapshot(chain);
  const toBlock = rawRound.blockTo;
  const lastBlock = rawRound.blockFrom;
  const transfers = rawRound.transfers;
  const traces = rawRound.traces;

  if (toBlock <= 0) {
    logger.info(`[${chain}] Could not get latest block. Skipping.`);
    return {
      chain,
      generated_at: new Date().toISOString(),
      block_from: lastBlock,
      block_to: toBlock,
      token_count: 0,
      tokens: [],
    };
  }

  logger.info(`[${chain}] Block range: (${lastBlock}, ${toBlock}]`);
  logger.info(`[${chain}] Transfers: ${transfers.length}`);
  logger.info(`[${chain}] Value traces: ${traces.length}`);
  emitProgress({
    stage: 'raw-data',
    label: 'Raw data collected',
    percent: 14,
    detail: `blocks ${lastBlock} -> ${toBlock}`,
  });

  const addrAgg = buildAddressActivityMap(transfers, traces);

  logger.info(`[${chain}] Unique addresses: ${addrAgg.size}`);

  if (!addrAgg.size) {
    logger.info(`[${chain}] No addresses found. Skipping.`);
    return {
      chain,
      generated_at: new Date().toISOString(),
      block_from: lastBlock,
      block_to: toBlock,
      token_count: 0,
      tokens: [],
    };
  }

  const uniqueAddrs = [...addrAgg.keys()];
  emitProgress({
    stage: 'contract-info',
    label: 'Fetching contract bytecode metadata',
    percent: 18,
    current: 0,
    total: uniqueAddrs.length,
  });
  const contractInfos = await getContractInfos(chain, uniqueAddrs);

  const contractAddrs: string[] = [];
  for (const addr of uniqueAddrs) {
    const info = contractInfos.get(addr);
    if (info?.bytecode) contractAddrs.push(addr);
  }
  logger.info(`[${chain}] Contracts with bytecode: ${contractAddrs.length}`);
  emitProgress({
    stage: 'contract-info',
    label: 'Contract metadata loaded',
    percent: 24,
    current: contractAddrs.length,
    total: uniqueAddrs.length,
  });

  emitProgress({
    stage: 'delegations',
    label: 'Resolving proxy and EIP-7702 delegations',
    percent: 28,
  });
  const delegateMap = await getDelegateCalls(chain, lastBlock, toBlock);
  const proxyMap = classifyDelegations(delegateMap, contractInfos);

  const eip7702Map = new Map<string, string>();
  for (const [addr, info] of proxyMap) {
    if (info.type === 'eip7702') eip7702Map.set(addr, info.implementation);
  }
  logger.info(`[${chain}] Proxies: ${proxyMap.size - eip7702Map.size}, EIP-7702: ${eip7702Map.size}`);
  emitProgress({
    stage: 'delegations',
    label: 'Delegation analysis ready',
    percent: 34,
    detail: `proxies ${proxyMap.size - eip7702Map.size}, eip7702 ${eip7702Map.size}`,
  });

  const implAddrsSet = new Set<string>();
  for (const info of proxyMap.values()) implAddrsSet.add(info.implementation);
  const implInfos = implAddrsSet.size ? await getContractInfos(chain, [...implAddrsSet]) : new Map();

  const candidates = new Set([
    ...contractAddrs,
    ...[...eip7702Map.keys()].filter(addr => addrAgg.has(addr)),
  ]);

  const getEffectiveBytecode = (addr: string): string => {
    const proxy = proxyMap.get(addr);
    if (proxy) return implInfos.get(proxy.implementation)?.bytecode ?? '';

    const delegate = eip7702Map.get(addr);
    if (delegate) return implInfos.get(delegate)?.bytecode ?? '';

    return contractInfos.get(addr)?.bytecode ?? '';
  };

  const seenEntries = getSeenSelectorEntries();
  const knownContractSet = getKnownContractSet(chain);
  const knownContractMap = getKnownContractMap(chain, [...candidates]);

  const whitelistPatterns = getWhitelistPatterns();
  const contractResults = new Map<string, TokenContractResult>();
  const newContractRows: Array<{
    contractAddr: string;
    linkage: string | null;
    linkType: 'proxy' | 'eip7702' | null;
    label: string;
    review?: string;
    contractSelectorHash: string | null;
    contractSelectors: string[];
    contractCodeSize: number;
    selectorHash: string | null;
    isExploitable: boolean;
    portfolio: string;
    deployedAt?: string | null;
    isAutoAudit?: boolean;
    isManualAudit?: boolean;
    whitelistPatterns: string[];
    selectors: string[];
    codeSize: number;
  }> = [];
  const contractPatternBackfillRows: Array<{
    contractAddr: string;
    linkage: string | null;
    linkType: 'proxy' | 'eip7702' | null;
    label: string;
    review?: string;
    contractSelectorHash: string | null;
    contractSelectors: string[];
    contractCodeSize: number;
    selectorHash: string | null;
    isExploitable: boolean;
    portfolio: string;
    deployedAt?: string | null;
    isAutoAudit?: boolean;
    isManualAudit?: boolean;
    whitelistPatterns: string[];
    selectors: string[];
    codeSize: number;
  }> = [];
  const totalCandidates = candidates.size;
  let analyzedCandidates = 0;

  for (const addr of candidates) {
    analyzedCandidates += 1;
    const agg = addrAgg.get(addr) ?? {
      xfer_out: 0,
      xfer_in: 0,
      eth_out: 0n,
      eth_in: 0n,
      tx_hashes: new Set<string>(),
    };
    const selfBytecode = contractInfos.get(addr)?.bytecode ?? '';
    const bytecode = getEffectiveBytecode(addr);
    const delegate = eip7702Map.get(addr);
    const proxy = proxyMap.get(addr);
    const known = knownContractMap.get(addr);
    const selfSelectors = extractSelectors(selfBytecode) ?? [];
    const effectiveSelectors = extractSelectors(bytecode) ?? [];
    const selfCodeSize = Math.floor(selfBytecode.length / 2);
    const effectiveCodeSize = Math.floor(bytecode.length / 2);
    const selfSeenEntry = matchSeenEntryBySimilarity(selfSelectors, selfCodeSize, seenEntries);
    const effectiveSeenEntry = matchSeenEntryBySimilarity(effectiveSelectors, effectiveCodeSize, seenEntries);
    const selfSeenLabel = selfSeenEntry?.label;
    const effectiveSeenLabel = effectiveSeenEntry?.label;
    const selfPatternHash = (selfBytecode.length > 0 || selfSelectors.length > 0)
      ? (selfSeenEntry?.hash ?? resolvePatternHash(selfSelectors, selfBytecode, `contract:${addr}`))
      : null;
    const effectivePatternKind: 'implementation' | 'delegate' | null = proxy
      ? 'implementation'
      : (delegate && delegate !== addr ? 'delegate' : null);
    const effectivePatternAddress = proxy?.implementation ?? (delegate && delegate !== addr ? delegate : null);
    const effectivePatternHash = effectivePatternKind && (bytecode.length > 0 || effectiveSelectors.length > 0)
      ? (effectiveSeenEntry?.hash ?? resolvePatternHash(
          effectiveSelectors,
          bytecode,
          `${effectivePatternKind}:${effectivePatternAddress}`,
        ))
      : selfPatternHash;
    const effectiveSelectorValues = effectivePatternKind ? effectiveSelectors : selfSelectors;
    const effectiveCodeSizeValue = effectivePatternKind ? effectiveCodeSize : selfCodeSize;
    const effectivePatternLabel = effectiveSeenLabel || selfSeenLabel;
    const knownPatternLabel = known?.label || effectivePatternLabel || selfSeenLabel;
    const patternTargets: PatternTargetInfo[] = [];

    if (known) {
      const linkage = known.linkage ?? proxy?.implementation ?? delegate ?? null;
      const linkType = known.linkType ?? (proxy ? 'proxy' : (delegate ? 'eip7702' : null));
      const storedContractHash = known.contractSelectorHash ?? (linkType ? null : known.selectorHash);
      const storedContractSelectors = known.contractSelectors.length
        ? known.contractSelectors
        : (linkType ? [] : known.selectors);
      const storedContractCodeSize = known.contractCodeSize || (linkType ? 0 : known.codeSize);
      const resolvedContractHash = selfPatternHash ?? storedContractHash ?? null;
      const resolvedContractSelectors = selfSelectors.length ? selfSelectors : storedContractSelectors;
      const resolvedContractCodeSize = selfCodeSize || storedContractCodeSize || effectiveCodeSize;
      const resolvedEffectiveHash = effectivePatternHash ?? known.selectorHash ?? resolvedContractHash;
      const resolvedEffectiveSelectors = effectiveSelectorValues.length ? effectiveSelectorValues : known.selectors;
      const resolvedEffectiveCodeSize = effectiveCodeSizeValue || known.codeSize || resolvedContractCodeSize;

      if (resolvedContractHash) {
        patternTargets.push({
          kind: 'contract',
          address: addr,
          code_size: resolvedContractCodeSize,
          pattern_hash: resolvedContractHash,
          ...(selfSeenLabel ? { seen_label: selfSeenLabel } : {}),
        });
      }
      if (
        linkType === 'proxy'
        && linkage
        && resolvedEffectiveHash
      ) {
        patternTargets.push({
          kind: 'implementation',
          address: linkage,
          code_size: resolvedEffectiveCodeSize,
          pattern_hash: resolvedEffectiveHash,
          ...(effectivePatternLabel ? { seen_label: effectivePatternLabel } : {}),
        });
      } else if (
        linkType === 'eip7702'
        && linkage
        && resolvedEffectiveHash
      ) {
        patternTargets.push({
          kind: 'delegate',
          address: linkage,
          code_size: resolvedEffectiveCodeSize,
          pattern_hash: resolvedEffectiveHash,
          ...(effectivePatternLabel ? { seen_label: effectivePatternLabel } : {}),
        });
      } else if (!patternTargets.length && resolvedEffectiveHash) {
        patternTargets.push({
          kind: 'contract',
          address: addr,
          code_size: resolvedEffectiveCodeSize,
          pattern_hash: resolvedEffectiveHash,
          ...(knownPatternLabel ? { seen_label: knownPatternLabel } : {}),
        });
      }

      const shouldBackfill = (
        (!known.label && Boolean(knownPatternLabel))
        || storedContractHash !== resolvedContractHash
        || !selectorListsEqual(storedContractSelectors, resolvedContractSelectors)
        || storedContractCodeSize !== resolvedContractCodeSize
        || known.selectorHash !== resolvedEffectiveHash
        || !selectorListsEqual(known.selectors, resolvedEffectiveSelectors)
        || known.codeSize !== resolvedEffectiveCodeSize
      );
      if (shouldBackfill) {
        contractPatternBackfillRows.push({
          contractAddr: addr,
          linkage,
          linkType,
          label: known.label || knownPatternLabel || '',
          review: known.review ?? '',
          contractSelectorHash: resolvedContractHash,
          contractSelectors: resolvedContractSelectors,
          contractCodeSize: resolvedContractCodeSize,
          selectorHash: resolvedEffectiveHash,
          isExploitable: known.isExploitable,
          portfolio: known.portfolio ?? '{}',
          deployedAt: contractInfos.get(addr)?.block_timestamp ?? known.deployedAt ?? null,
          isAutoAudit: known.isAutoAudit,
          isManualAudit: known.isManualAudit,
          whitelistPatterns: known.whitelistPatterns,
          selectors: resolvedEffectiveSelectors,
          codeSize: resolvedEffectiveCodeSize,
        });
      }

      const knownResult: TokenContractResult = {
        contract: addr,
        xfer_out: agg.xfer_out,
        xfer_in: agg.xfer_in,
        eth_out: agg.eth_out.toString(),
        eth_in: agg.eth_in.toString(),
        tx_count: agg.tx_hashes.size,
        matched_whitelist: known.whitelistPatterns,
        selectors: resolvedEffectiveSelectors,
        code_size: resolvedEffectiveCodeSize,
        seen_label: knownPatternLabel || undefined,
        transfer_in_count: 0,
        transfer_in_amount: '0',
        transfer_out_count: 0,
        transfer_out_amount: '0',
        pair_tx_count: 0,
        current_balance: null,
        total_token_flow: '0',
        flow_breakdown: [],
        created_at: contractInfos.get(addr)?.block_timestamp ?? null,
        pattern_targets: patternTargets,
        reviews: [],
        is_exploitable: known.isExploitable,
      };
      if (linkType === 'proxy' && linkage) knownResult.proxy_impl = linkage;
      if (linkType === 'eip7702' && linkage) knownResult.eip7702_delegate = linkage;
      contractResults.set(addr, knownResult);
      if (
        analyzedCandidates === totalCandidates
        || analyzedCandidates % CONTRACT_ANALYSIS_PROGRESS_STEP === 0
      ) {
        emitProgress({
          stage: 'contract-analysis',
          label: 'Analyzing contract candidates',
          percent: 34 + ((analyzedCandidates / Math.max(totalCandidates, 1)) * 20),
          current: analyzedCandidates,
          total: totalCandidates,
        });
      }
      continue;
    }

    if (selfPatternHash) {
      patternTargets.push({
        kind: 'contract',
        address: addr,
        code_size: selfCodeSize,
        pattern_hash: selfPatternHash,
        ...(selfSeenLabel ? { seen_label: selfSeenLabel } : {}),
      });
    }
    if (
      effectivePatternKind === 'implementation'
      && effectivePatternAddress
      && effectivePatternHash
    ) {
      patternTargets.push({
        kind: 'implementation',
        address: effectivePatternAddress,
        code_size: effectiveCodeSize,
        pattern_hash: effectivePatternHash,
        ...(effectiveSeenLabel ? { seen_label: effectiveSeenLabel } : {}),
      });
    } else if (
      effectivePatternKind === 'delegate'
      && effectivePatternAddress
      && effectivePatternHash
    ) {
      patternTargets.push({
        kind: 'delegate',
        address: effectivePatternAddress,
        code_size: effectiveCodeSize,
        pattern_hash: effectivePatternHash,
        ...(effectiveSeenLabel ? { seen_label: effectiveSeenLabel } : {}),
      });
    }

    const scored = scoreContract(
      addr,
      agg.tx_hashes.size,
      agg.xfer_out,
      agg.xfer_in,
      agg.eth_out,
      agg.eth_in,
      bytecode,
      whitelistPatterns,
      delegate,
    );

    const result: TokenContractResult = {
      ...scored,
      transfer_in_count: 0,
      transfer_in_amount: '0',
      transfer_out_count: 0,
      transfer_out_amount: '0',
      pair_tx_count: 0,
      current_balance: null,
      total_token_flow: '0',
      flow_breakdown: [],
      created_at: contractInfos.get(addr)?.block_timestamp ?? null,
      pattern_targets: patternTargets,
      reviews: [],
      is_exploitable: false,
      selectors: effectiveSelectors,
      seen_label: effectivePatternLabel || undefined,
    };
    if (proxy) result.proxy_impl = proxy.implementation;
    if (delegate) result.eip7702_delegate = delegate;
    contractResults.set(addr, result);

    if (!knownContractSet.has(addr)) {
      const primaryTarget = primaryPatternTarget(result.pattern_targets);
      newContractRows.push({
        contractAddr: addr,
        linkage: proxy?.implementation ?? delegate ?? null,
        linkType: proxy ? 'proxy' : (delegate ? 'eip7702' : null),
        label: result.seen_label ?? '',
        review: '',
        contractSelectorHash: selfPatternHash,
        contractSelectors: selfSelectors,
        contractCodeSize: selfCodeSize,
        selectorHash: primaryTarget?.pattern_hash ?? selfPatternHash,
        isExploitable: false,
        portfolio: '{}',
        deployedAt: result.created_at ?? null,
        isAutoAudit: false,
        isManualAudit: false,
        whitelistPatterns: result.matched_whitelist ?? [],
        selectors: result.selectors ?? [],
        codeSize: result.code_size ?? effectiveCodeSize,
      });
    }

    if (
      analyzedCandidates === totalCandidates
      || analyzedCandidates % CONTRACT_ANALYSIS_PROGRESS_STEP === 0
    ) {
      emitProgress({
        stage: 'contract-analysis',
        label: 'Analyzing contract candidates',
        percent: 34 + ((analyzedCandidates / Math.max(totalCandidates, 1)) * 20),
        current: analyzedCandidates,
        total: totalCandidates,
      });
    }
  }

  const tokenAggs = buildTokenAggs(
    chain,
    transfers,
    traces,
    new Set(contractResults.keys()),
    contractInfos,
  );

  const reviewHashSet = new Set<string>();
  for (const result of contractResults.values()) {
    for (const target of result.pattern_targets) {
      reviewHashSet.add(target.pattern_hash);
    }
  }
  const reviewMap = getSeenContractReviewsByPatternHashes([...reviewHashSet]);
  for (const result of contractResults.values()) {
    const reviews = result.pattern_targets.flatMap((target) =>
      (reviewMap.get(target.pattern_hash) ?? [])
        .filter((entry) =>
          entry.chain === chain.toLowerCase()
          && entry.contractAddress === result.contract.toLowerCase(),
        )
        .map(mapSeenContractReview),
    );
    result.reviews = reviews;
    result.is_exploitable = reviews.some((item) => item.exploitable);
  }

  const contractsToPersist = newContractRows.map((row) => {
    const latest = contractResults.get(row.contractAddr);
    return {
      ...row,
      label: latest?.seen_label ?? row.label,
      isExploitable: latest?.is_exploitable ?? row.isExploitable,
      whitelistPatterns: latest?.matched_whitelist ?? row.whitelistPatterns,
      selectors: latest?.selectors ?? row.selectors,
      codeSize: latest?.code_size ?? row.codeSize,
      deployedAt: latest?.created_at ?? row.deployedAt ?? null,
      selectorHash: primaryPatternTarget(latest?.pattern_targets ?? [])?.pattern_hash ?? row.selectorHash,
    };
  });
  persistNewContracts({ chain, rows: contractsToPersist });
  backfillContractPatternMetadata({ chain, rows: contractPatternBackfillRows });
  backfillContractDeployments(
    chain,
    [...contractResults.entries()].map(([contractAddr, result]) => ({
      contractAddr,
      deployedAt: result.created_at ?? null,
    })),
  );
  emitProgress({
    stage: 'contract-analysis',
    label: 'Contract registry updated',
    percent: 56,
    current: contractsToPersist.length,
    total: totalCandidates,
    detail: `persisted ${contractsToPersist.length} new contract(s)`,
  });

  if (!tokenAggs.size) {
    const emptyRun = {
      chain,
      generated_at: new Date().toISOString(),
      block_from: lastBlock,
      block_to: toBlock,
      token_count: 0,
      tokens: [],
    };
    logger.info(`[${chain}] No token-linked candidate contracts found.`);
    return emptyRun;
  }

  const tokenMetadataMap = new Map<string, TokenMetadata>();
  const balanceMap = new Map<string, string | null>();
  const hasRpc = chainConfig.rpcUrls.length > 0;

  let tokens = [...tokenAggs.keys()];
  emitProgress({
    stage: 'token-sync',
    label: 'Preparing token metadata and balances',
    percent: 80,
    current: 0,
    total: tokens.length,
  });
  const nativeTokenRef = getNativeTokenRef(chain);
  const tokenMetadataCache = getTokenMetadataCache(chain, tokens);
  tokenMetadataCache.forEach((row, token) => {
    tokenMetadataMap.set(token, {
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals,
      priceUsd: row.tokenPriceUsd,
      tokenKind: row.tokenKind ?? null,
      isAutoAudited: row.isAutoAudited,
      isManualAudited: row.isManualAudited,
    });
  });
  const tokenFactsMap = new Map<string, TokenContractFacts>();
  const missingTokenFacts = tokens.filter((token) => {
    if (token === nativeTokenRef) return false;
    const cached = tokenMetadataCache.get(token);
    return !cached || cached.tokenCallsSync === null;
  });

  const tokenContractInfoMap = missingTokenFacts.length
    ? await getContractInfos(chain, missingTokenFacts)
    : new Map<string, ContractInfo>();

  for (const token of tokens) {
    if (token === nativeTokenRef) {
      tokenFactsMap.set(token, {
        tokenCreatedAt: null,
        tokenCallsSync: null,
      });
      continue;
    }

    const cached = tokenMetadataCache.get(token);
    if (cached && cached.tokenCallsSync !== null) {
      tokenFactsMap.set(token, {
        tokenCreatedAt: cached.tokenCreatedAt,
        tokenCallsSync: cached.tokenCallsSync,
      });
      continue;
    }

    const info = tokenContractInfoMap.get(token);
    const tokenCreatedAt = info?.block_timestamp ?? cached?.tokenCreatedAt ?? null;
    const tokenCallsSync = info?.bytecode
      ? detectSyncCallPattern(info.bytecode)
      : false;

    tokenFactsMap.set(token, {
      tokenCreatedAt,
      tokenCallsSync,
    });
  }

  const factsToPersist = tokens
    .filter((token) => token !== nativeTokenRef && tokenContractInfoMap.has(token))
    .map((token) => {
      const facts = tokenFactsMap.get(token);
      return {
        token,
        tokenCreatedAt: facts?.tokenCreatedAt ?? null,
        tokenCallsSync: facts?.tokenCallsSync ?? false,
        is_native: false,
      };
    });
  upsertTokenContractFactsBatch(chain, factsToPersist);
  emitProgress({
    stage: 'token-sync',
    label: 'Token facts synchronized',
    percent: 84,
    current: factsToPersist.length,
    total: tokens.length,
  });

  if (hasRpc) {
    emitProgress({
      stage: 'token-sync',
      label: 'Fetching token metadata and balances via RPC',
      percent: 86,
      detail: `${tokens.length} token(s)`,
    });
    const metadataBatch = await getTokenMetadataBatch(chain, tokens);
    metadataBatch.forEach((value, key) => tokenMetadataMap.set(key, value));

    const excludedTokens = tokens.filter((token) => !isFungibleTokenKind(tokenMetadataMap.get(token)?.tokenKind));
    if (excludedTokens.length) {
      excludedTokens.forEach((token) => {
        tokenAggs.delete(token);
        tokenMetadataMap.delete(token);
        tokenFactsMap.delete(token);
      });
      tokens = tokens.filter((token) => !excludedTokens.includes(token));
      logger.info(`[${chain}] Filtered ${excludedTokens.length} non-fungible token(s) from aggregation`);
    }

    const balanceTasks = [...tokenAggs.values()].flatMap(tokenAgg =>
      [...tokenAgg.contracts.keys()].map(contract => ({ token: tokenAgg.token, contract })),
    );
    const balances = await getTokenBalancesBatch(
      chain,
      balanceTasks.map(({ token, contract }) => ({ token, owner: contract })),
    );
    balances.forEach((value, key) => balanceMap.set(key, value));
  } else {
    logger.warn(`[${chain}] No RPC URLs configured. Token metadata and balances will be empty.`);
  }

  const tokenPriceBatch = await syncTokenRegistryForRound({
    chain,
    tokens,
    metadataMap: tokenMetadataMap,
    tokenFactsMap,
    nativeTokenRef,
  });
  emitProgress({
    stage: 'token-sync',
    label: 'Token registry and prices updated',
    percent: 92,
    current: tokenPriceBatch.size,
    total: tokens.length,
  });
  tokenPriceBatch.forEach((priceUsd, token) => {
    const safePriceUsd = sanitizeTokenPriceUsd(priceUsd);
    if (safePriceUsd == null) return;
    const current = tokenMetadataMap.get(token) ?? {
      name: null,
      symbol: null,
      decimals: null,
      priceUsd: null,
      tokenKind: null,
      isAutoAudited: false,
      isManualAudited: false,
    };
    tokenMetadataMap.set(token, {
      ...current,
      priceUsd: safePriceUsd,
    });
  });

  upsertTokenPriceBatch(
    chain,
    [...tokenPriceBatch.entries()]
      .map(([token, priceUsd]) => ({ token, tokenPriceUsd: sanitizeTokenPriceUsd(priceUsd) }))
      .filter((row): row is { token: string; tokenPriceUsd: number } => row.tokenPriceUsd != null),
  );

  const missingPriceTokens = getTokensMissingPrice(chain, TOKEN_PRICE_BACKFILL_BATCH_SIZE);
  const missingTokensOutsideCurrentRun = missingPriceTokens.filter((token) => !tokenPriceBatch.has(token));
  if (missingTokensOutsideCurrentRun.length) {
    const backfillPrices = await getTokenPricesBatch(chain, missingTokensOutsideCurrentRun);
    const rows = [...backfillPrices.entries()]
      .map(([token, priceUsd]) => ({ token, tokenPriceUsd: sanitizeTokenPriceUsd(priceUsd) }))
      .filter((row): row is { token: string; tokenPriceUsd: number } => row.tokenPriceUsd != null);
    upsertTokenPriceBatch(chain, rows);
    logger.info(`[${chain}] Token price backfill: ${rows.length}/${missingTokensOutsideCurrentRun.length}`);
  }

  if (hasRpc) {
    const balanceRows = [...tokenAggs.values()].flatMap((tokenAgg) =>
      [...tokenAgg.contracts.keys()].map((contractAddr) => ({
        tokenAddress: tokenAgg.token,
        contractAddr,
        balance: balanceMap.get(`${tokenAgg.token}:${contractAddr}`) ?? null,
      })),
    );
    persistTokenContractBalances(chain, balanceRows);
  }
  emitProgress({
    stage: 'portfolio',
    label: 'Calculating contract total USD',
    percent: 94,
    current: 0,
    total: contractResults.size,
  });
  const contractPortfolioMap = computeContractPortfolioUsd({
    contractAddresses: [...contractResults.keys()],
    tokenAggs,
    tokenMetadataMap,
    balanceMap,
  });
  const portfolioRows = [...contractResults.keys()].map((contractAddr) => ({
    contractAddr,
    portfolio: String(contractPortfolioMap.get(contractAddr.toLowerCase()) ?? 0),
  }));
  updateRoundPortfolio(chain, portfolioRows);
  emitProgress({
    stage: 'portfolio',
    label: 'Contract total USD calculated',
    percent: 95,
    current: portfolioRows.length,
    total: contractResults.size,
  });
  emitProgress({
    stage: 'finalize',
    label: 'Building token result view',
    percent: 97,
    current: tokenAggs.size,
    total: tokenAggs.size,
  });

  const tokenResults: TokenResult[] = [...tokenAggs.values()]
    .map((tokenAgg) => {
      const metadata = tokenMetadataMap.get(tokenAgg.token) ?? {
        name: null,
        symbol: null,
        decimals: null,
        priceUsd: null,
        tokenKind: null,
        isAutoAudited: false,
        isManualAudited: false,
      };

      const contracts: TokenContractResult[] = [...tokenAgg.contracts.values()]
        .map((pairAgg) => {
          const base = contractResults.get(pairAgg.contract);
          if (!base) return null;

          const totalFlow = pairAgg.transfer_in_amount + pairAgg.transfer_out_amount;
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
            ...base,
            transfer_in_count: pairAgg.transfer_in_count,
            transfer_in_amount: pairAgg.transfer_in_amount.toString(),
            transfer_out_count: pairAgg.transfer_out_count,
            transfer_out_amount: pairAgg.transfer_out_amount.toString(),
            pair_tx_count: pairAgg.tx_hashes.size,
            current_balance: balanceMap.get(`${tokenAgg.token}:${pairAgg.contract}`) ?? null,
            total_token_flow: totalFlow.toString(),
            flow_breakdown: flowBreakdown,
          };
        })
        .filter((value): value is TokenContractResult => value !== null)
        .sort(compareTokenContractsByBalance);

      const rankedGroups: RankedTokenContractGroup[] = groupBySimilarity(contracts)
        .flatMap<RankedTokenContractGroup>((group) => {
          const sortedMembers = [...group.members].sort(compareTokenContractsByBalance);

          if (group.kind === 'single') {
            return sortedMembers.map((member) => ({
              id: `single:${member.contract}`,
              kind: 'single' as const,
              label: member.contract,
              contract_count: 1,
              total_transfer_amount: member.total_token_flow,
              max_balance: member.current_balance ?? '0',
              contracts: [member],
            }));
          }

          const maxBalance = sortedMembers.reduce(
            (max, item) => {
              const balance = safeBigInt(item.current_balance);
              return balance > max ? balance : max;
            },
            0n,
          );

          return [{
            id: group.id,
            kind: group.kind,
            label: group.label,
            contract_count: sortedMembers.length,
            total_transfer_amount: sortedMembers
              .reduce((sum, item) => sum + safeBigInt(item.total_token_flow), 0n)
              .toString(),
            max_balance: maxBalance.toString(),
            contracts: sortedMembers,
          }];
        })
        .sort((a, b) => {
          const balanceDelta = safeBigInt(b.max_balance) - safeBigInt(a.max_balance);
          if (balanceDelta !== 0n) return balanceDelta > 0n ? 1 : -1;

          const flowDelta = safeBigInt(b.total_transfer_amount) - safeBigInt(a.total_transfer_amount);
          if (flowDelta !== 0n) return flowDelta > 0n ? 1 : -1;

          return b.contract_count - a.contract_count;
        });

      const groups: TokenContractGroup[] = rankedGroups
        .map(({ max_balance: _maxBalance, ...group }) => group);

      return {
        chain,
        token: tokenAgg.token,
        is_native: tokenAgg.token === nativeTokenRef,
        token_name: metadata.name,
        token_symbol: metadata.symbol,
        decimals: metadata.decimals,
        token_price_usd: metadata.priceUsd,
        token_created_at: tokenFactsMap.get(tokenAgg.token)?.tokenCreatedAt ?? null,
        token_calls_sync: tokenFactsMap.get(tokenAgg.token)?.tokenCallsSync ?? null,
        is_auto_audit: metadata.isAutoAudited ?? false,
        is_manual_audit: metadata.isManualAudited ?? false,
        related_contract_count: contracts.length,
        total_transfer_count: tokenAgg.total_transfer_count,
        total_transfer_amount: tokenAgg.total_transfer_amount.toString(),
        groups,
      };
    })
    .sort((a, b) => {
      if (b.related_contract_count !== a.related_contract_count) {
        return b.related_contract_count - a.related_contract_count;
      }
      const delta = safeBigInt(b.total_transfer_amount) - safeBigInt(a.total_transfer_amount);
      if (delta !== 0n) return delta > 0n ? 1 : -1;
      return b.total_transfer_count - a.total_transfer_count;
    });

  const runResult: PipelineRunResult = {
    chain,
    generated_at: new Date().toISOString(),
    block_from: lastBlock,
    block_to: toBlock,
    token_count: tokenResults.length,
    tokens: tokenResults,
  };

  logger.info(`[${chain}] Round complete. Tokens: ${runResult.token_count}`);
  emitProgress({
    stage: 'complete',
    label: 'Round complete',
    percent: 100,
    current: runResult.token_count,
    total: runResult.token_count,
    detail: `${runResult.token_count} token(s) in result`,
  });

  return runResult;
}

import { getDefaultAiAuditModel, getDefaultAiAuditProvider, normalizeAiAuditModel, normalizeAiAuditProvider } from '../config.js';
import { coerceBoolean, normalizeDateTimeLocalInput } from './request-utils.js';

export interface CoercedAutoAnalysisRuntimeConfig {
  selectedChains: string[];
  chainRatios: Record<string, number>;
  chainConfigs: Record<string, {
    fromBlock: number | null;
    toBlock: number | null;
    deltaBlocks: number | null;
    tokenSharePercent: number;
    contractSharePercent: number;
  }>;
  queueCapacity: number;
  continueOnEmptyRound: boolean;
  provider: string;
  model: string;
  contractMinTvlUsd: number;
  tokenMinPriceUsd: number;
  requireTokenSync: boolean;
  requireContractSelectors: boolean;
  skipSeenContracts: boolean;
  onePerContractPattern: boolean;
  retryFailedAudits: boolean;
  excludeAuditedContracts: boolean;
  excludeAuditedTokens: boolean;
  rangeInputError: string | null;
}

export function coerceAutoAnalysisRuntimeConfig(input: unknown): CoercedAutoAnalysisRuntimeConfig {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const toPositiveInt = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  const toPercentInt = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0
      ? Math.max(0, Math.min(100, Math.floor(parsed)))
      : fallback;
  };
  const toOptionalBlock = (value: unknown) => {
    if (value == null) return { value: null, valid: true };
    const normalized = String(value).trim();
    if (!normalized) return { value: null, valid: true };
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      return { value: null, valid: false };
    }
    return { value: Math.floor(parsed), valid: true };
  };

  const provider = normalizeAiAuditProvider(String(source.provider || getDefaultAiAuditProvider()).trim());
  const selectedChains = Array.isArray(source.selected_chains)
    ? [...new Set(source.selected_chains.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean))]
    : [];
  const rawChainRatios = source.chain_ratios && typeof source.chain_ratios === 'object'
    ? source.chain_ratios as Record<string, unknown>
    : {};
  const chainRatios = Object.fromEntries(
    selectedChains.map((chain) => {
      const parsed = Number(rawChainRatios[chain]);
      return [chain, Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : 100];
    }),
  );
  const rawChainConfigs = source.chain_configs && typeof source.chain_configs === 'object'
    ? source.chain_configs as Record<string, unknown>
    : {};
  let rangeInputError: string | null = null;
  const chainConfigs = Object.fromEntries(
    selectedChains.map((chain) => {
      const rawConfig = rawChainConfigs[chain] && typeof rawChainConfigs[chain] === 'object'
        ? rawChainConfigs[chain] as Record<string, unknown>
        : {};
      const fromBlock = toOptionalBlock(rawConfig.from_block ?? rawConfig.fromBlock);
      const toBlock = toOptionalBlock(rawConfig.to_block ?? rawConfig.toBlock);
      const deltaBlocks = toOptionalBlock(rawConfig.delta_blocks ?? rawConfig.deltaBlocks);
      if (!rangeInputError && (!fromBlock.valid || !toBlock.valid || !deltaBlocks.valid)) {
        rangeInputError = `Auto-analysis ${chain.toUpperCase()} From/To/Delta block must be a non-negative integer`;
      } else if (!rangeInputError && fromBlock.value != null && toBlock.value != null && toBlock.value <= fromBlock.value) {
        rangeInputError = `Auto-analysis ${chain.toUpperCase()} To block must be greater than From block`;
      }
      return [chain, {
        fromBlock: fromBlock.value,
        toBlock: toBlock.value,
        deltaBlocks: deltaBlocks.value,
        tokenSharePercent: toPercentInt(rawConfig.token_share_percent ?? rawConfig.tokenSharePercent, 40),
        contractSharePercent: toPercentInt(rawConfig.contract_share_percent ?? rawConfig.contractSharePercent, 60),
      }];
    }),
  );

  return {
    selectedChains,
    chainRatios,
    chainConfigs,
    queueCapacity: toPositiveInt(source.queue_capacity, 10),
    continueOnEmptyRound: coerceBoolean(source.continue_on_empty_round, false),
    provider,
    model: normalizeAiAuditModel(provider, String(source.model || getDefaultAiAuditModel(provider)).trim()),
    contractMinTvlUsd: Number.isFinite(Number(source.contract_min_tvl_usd)) ? Number(source.contract_min_tvl_usd) : 10_000,
    tokenMinPriceUsd: Number.isFinite(Number(source.token_min_price_usd)) ? Number(source.token_min_price_usd) : 0.001,
    requireTokenSync: coerceBoolean(source.require_token_sync, true),
    requireContractSelectors: coerceBoolean(source.require_contract_selectors, true),
    skipSeenContracts: coerceBoolean(source.skip_seen_contracts, true),
    onePerContractPattern: coerceBoolean(source.one_per_contract_pattern, true),
    retryFailedAudits: coerceBoolean(source.retry_failed_audits, true),
    excludeAuditedContracts: coerceBoolean(source.exclude_audited_contracts, true),
    excludeAuditedTokens: coerceBoolean(source.exclude_audited_tokens, true),
    rangeInputError,
  };
}

export { normalizeDateTimeLocalInput };

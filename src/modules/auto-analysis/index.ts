import {
  getLatestContractAiAudits,
  getLatestTokenAiAudits,
  requestContractAiAudit,
  requestTokenAiAudit,
  type ContractRegistryRow,
} from '../../db.js';
import {
  getDefaultAiAuditModel,
  getDefaultAiAuditProvider,
  normalizeAiAuditModel,
  normalizeAiAuditProvider,
} from '../../config.js';
import { logger } from '../../utils/logger.js';
import {
  enqueueContractAiAudit,
  enqueueTokenAiAudit,
  getAiAuditWorkerStatus,
  getContractAiAuditPlan,
  setAiAuditWorkerCapacity,
} from '../ai-audit-runner/index.js';
import {
  listDashboardContractsRegistry,
  listDashboardSeenSelectors,
  listDashboardStoredTokens,
} from '../dashboard/repository.js';
import { loadPersistedAutoAnalysisState, persistAutoAnalysisState, type AutoAnalysisPhase } from './state.js';

const LOOP_INTERVAL_MS = 2_500;
const FAILURE_BACKOFF_MS = 10_000;
const DEFAULT_AUTO_ANALYSIS_PROVIDER = getDefaultAiAuditProvider();

export interface AutoAnalysisStatus {
  enabled: boolean;
  stopping: boolean;
  chain: string | null;
  chains: string[];
  chainRatios: Record<string, number>;
  phase: AutoAnalysisPhase;
  queued: number;
  active: number;
  capacity: number;
  cycle: number;
  lastAction: string;
  updatedAt: string;
}

export interface AutoAnalysisRuntimeConfig {
  selectedChains: string[];
  chainRatios: Record<string, number>;
  queueCapacity: number;
  roundAuditLimit: number;
  roundRestSeconds: number;
  continueOnEmptyRound: boolean;
  stopAtDateTime: string | null;
  tokenSharePercent: number;
  contractSharePercent: number;
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
}

interface AutoAnalysisControls {
  runRound: (chain: string) => Promise<unknown>;
  isRoundRunning: () => boolean;
}

export interface AutoAnalysisStatusEvent extends AutoAnalysisStatus {
  username: string;
}

type AutoAnalysisListener = (event: AutoAnalysisStatusEvent) => void | Promise<void>;

interface AutoAnalysisContext {
  username: string;
  runtimeConfig: AutoAnalysisRuntimeConfig;
  state: AutoAnalysisStatus;
  loopPromise: Promise<void> | null;
  roundQueuedSinceRest: number;
  roundRestUntilMs: number;
  roundChainCursor: number;
  backendApiKey: string;
}

const listeners = new Set<AutoAnalysisListener>();
const contexts = new Map<string, AutoAnalysisContext>();

const DEFAULT_AUTO_ANALYSIS_CONFIG: AutoAnalysisRuntimeConfig = {
  selectedChains: [],
  chainRatios: {},
  queueCapacity: 10,
  roundAuditLimit: 5,
  roundRestSeconds: 60,
  continueOnEmptyRound: false,
  stopAtDateTime: null,
  tokenSharePercent: 40,
  contractSharePercent: 60,
  provider: DEFAULT_AUTO_ANALYSIS_PROVIDER,
  model: getDefaultAiAuditModel(DEFAULT_AUTO_ANALYSIS_PROVIDER),
  contractMinTvlUsd: 10_000,
  tokenMinPriceUsd: 0.001,
  requireTokenSync: true,
  requireContractSelectors: true,
  skipSeenContracts: true,
  onePerContractPattern: true,
  retryFailedAudits: true,
  excludeAuditedContracts: true,
  excludeAuditedTokens: true,
};

let controls: AutoAnalysisControls | null = null;

function normalizeUsernameKey(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeChainKey(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parsePositiveFloat(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeDateTimeLocal(value: unknown): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeSelectedChains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => normalizeChainKey(entry)).filter(Boolean))];
}

function normalizeChainRatios(
  value: unknown,
  selectedChains: string[],
  fallback: Record<string, number> = {},
): Record<string, number> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const next: Record<string, number> = {};
  for (const chain of selectedChains) {
    const fallbackValue = Number(fallback[chain]);
    const rawValue = source[chain] ?? source[normalizeChainKey(chain)] ?? fallbackValue;
    const parsed = Number(rawValue);
    next[chain] = Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : 100;
  }
  return next;
}

function describeChainSet(chains: string[]): string {
  if (!chains.length) return '--';
  return chains.map((chain) => chain.toUpperCase()).join(', ');
}

function normalizeRuntimeConfig(input: Partial<AutoAnalysisRuntimeConfig> | null | undefined, base: AutoAnalysisRuntimeConfig): AutoAnalysisRuntimeConfig {
  const merged = {
    ...DEFAULT_AUTO_ANALYSIS_CONFIG,
    ...base,
    ...(input || {}),
  };
  const provider = normalizeAiAuditProvider(merged.provider);
  const selectedChains = normalizeSelectedChains(merged.selectedChains);
  const chainRatios = normalizeChainRatios(merged.chainRatios, selectedChains, base.chainRatios);
  return {
    selectedChains,
    chainRatios,
    queueCapacity: parsePositiveInt(merged.queueCapacity, DEFAULT_AUTO_ANALYSIS_CONFIG.queueCapacity),
    roundAuditLimit: parsePositiveInt(merged.roundAuditLimit, DEFAULT_AUTO_ANALYSIS_CONFIG.roundAuditLimit),
    roundRestSeconds: parsePositiveInt(merged.roundRestSeconds, DEFAULT_AUTO_ANALYSIS_CONFIG.roundRestSeconds),
    continueOnEmptyRound: parseBoolean(merged.continueOnEmptyRound, DEFAULT_AUTO_ANALYSIS_CONFIG.continueOnEmptyRound),
    stopAtDateTime: normalizeDateTimeLocal(merged.stopAtDateTime),
    tokenSharePercent: parsePositiveInt(merged.tokenSharePercent, DEFAULT_AUTO_ANALYSIS_CONFIG.tokenSharePercent),
    contractSharePercent: parsePositiveInt(merged.contractSharePercent, DEFAULT_AUTO_ANALYSIS_CONFIG.contractSharePercent),
    provider,
    model: normalizeAiAuditModel(provider, merged.model),
    contractMinTvlUsd: parsePositiveFloat(merged.contractMinTvlUsd, DEFAULT_AUTO_ANALYSIS_CONFIG.contractMinTvlUsd),
    tokenMinPriceUsd: parsePositiveFloat(merged.tokenMinPriceUsd, DEFAULT_AUTO_ANALYSIS_CONFIG.tokenMinPriceUsd),
    requireTokenSync: parseBoolean(merged.requireTokenSync, DEFAULT_AUTO_ANALYSIS_CONFIG.requireTokenSync),
    requireContractSelectors: parseBoolean(merged.requireContractSelectors, DEFAULT_AUTO_ANALYSIS_CONFIG.requireContractSelectors),
    skipSeenContracts: parseBoolean(merged.skipSeenContracts, DEFAULT_AUTO_ANALYSIS_CONFIG.skipSeenContracts),
    onePerContractPattern: parseBoolean(merged.onePerContractPattern, DEFAULT_AUTO_ANALYSIS_CONFIG.onePerContractPattern),
    retryFailedAudits: parseBoolean(merged.retryFailedAudits, DEFAULT_AUTO_ANALYSIS_CONFIG.retryFailedAudits),
    excludeAuditedContracts: parseBoolean(merged.excludeAuditedContracts, DEFAULT_AUTO_ANALYSIS_CONFIG.excludeAuditedContracts),
    excludeAuditedTokens: parseBoolean(merged.excludeAuditedTokens, DEFAULT_AUTO_ANALYSIS_CONFIG.excludeAuditedTokens),
  };
}

function createDefaultState(): AutoAnalysisStatus {
  const persisted = loadPersistedAutoAnalysisState();
  return {
    enabled: persisted.enabled,
    stopping: persisted.stopping,
    chain: persisted.chain,
    chains: [],
    chainRatios: {},
    phase: persisted.phase,
    queued: 0,
    active: 0,
    capacity: getAiAuditWorkerStatus().capacity,
    cycle: persisted.cycle,
    lastAction: persisted.lastAction,
    updatedAt: new Date().toISOString(),
  };
}

function ensureContext(username: string): AutoAnalysisContext {
  const key = normalizeUsernameKey(username);
  const existing = contexts.get(key);
  if (existing) return existing;
  const context: AutoAnalysisContext = {
    username: key,
    runtimeConfig: { ...DEFAULT_AUTO_ANALYSIS_CONFIG },
    state: createDefaultState(),
    loopPromise: null,
    roundQueuedSinceRest: 0,
    roundRestUntilMs: 0,
    roundChainCursor: 0,
    backendApiKey: '',
  };
  context.state.enabled = false;
  context.state.stopping = false;
  context.state.chain = null;
  context.state.chains = [];
  context.state.chainRatios = {};
  context.state.phase = 'idle';
  context.state.lastAction = 'Auto analysis is idle';
  contexts.set(key, context);
  return context;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function groupKeyForContract(row: ContractRegistryRow): string {
  if (row.selectorHash) return `hash:${row.selectorHash}`;
  if (row.selectors.length) return `selectors:${[...row.selectors].sort().join(',')}`;
  return `contract:${row.contractAddr}`;
}

function hasNonRetryableAudit(audit: { status?: unknown } | undefined): boolean {
  const status = String(audit?.status || '').trim().toLowerCase();
  return status === 'requested' || status === 'running' || status === 'completed';
}

function shouldTreatAuditAsHandled(
  audit: { status?: unknown } | undefined,
  retryFailedAudits: boolean,
): boolean {
  if (hasNonRetryableAudit(audit)) return true;
  if (!retryFailedAudits) {
    const status = String(audit?.status || '').trim().toLowerCase();
    if (status === 'failed') return true;
  }
  return false;
}

function persistState(_context: AutoAnalysisContext): void {
  persistAutoAnalysisState({
    enabled: false,
    stopping: false,
    chain: null,
    phase: 'idle',
    cycle: 0,
    lastAction: 'Auto analysis is idle',
  });
}

function recomputeWorkerCapacity(): void {
  const capacities = Array.from(contexts.values())
    .map((context) => Number(context.runtimeConfig.queueCapacity || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  setAiAuditWorkerCapacity(capacities.length ? Math.max(...capacities) : DEFAULT_AUTO_ANALYSIS_CONFIG.queueCapacity);
}

function refreshWorkerStatus(context: AutoAnalysisContext): void {
  const worker = getAiAuditWorkerStatus(context.username);
  context.state.queued = worker.queued;
  context.state.active = worker.active;
  context.state.capacity = worker.capacity;
}

function publish(context: AutoAnalysisContext): void {
  refreshWorkerStatus(context);
  context.state.updatedAt = new Date().toISOString();
  const payload: AutoAnalysisStatusEvent = {
    username: context.username,
    ...context.state,
  };
  for (const listener of listeners) {
    try {
      void listener(payload);
    } catch {
      // no-op
    }
  }
}

function setStatus(context: AutoAnalysisContext, patch: Partial<AutoAnalysisStatus>): void {
  Object.assign(context.state, patch);
  persistState(context);
  publish(context);
}

function totalInFlight(context: AutoAnalysisContext): number {
  refreshWorkerStatus(context);
  return context.state.queued + context.state.active;
}

function currentWorkerStatus(context: AutoAnalysisContext) {
  const worker = getAiAuditWorkerStatus(context.username);
  context.state.queued = worker.queued;
  context.state.active = worker.active;
  context.state.capacity = worker.capacity;
  return worker;
}

function getConfiguredChains(context: AutoAnalysisContext): string[] {
  return context.runtimeConfig.selectedChains.length
    ? [...context.runtimeConfig.selectedChains]
    : (context.state.chain ? [context.state.chain] : []);
}

function syncContextChainState(context: AutoAnalysisContext): void {
  const chains = getConfiguredChains(context);
  context.state.chains = [...chains];
  context.state.chainRatios = normalizeChainRatios(
    context.runtimeConfig.chainRatios,
    chains,
    context.state.chainRatios,
  );
  if (!chains.length) {
    context.state.chain = null;
    context.roundChainCursor = 0;
    return;
  }
  if (!context.state.chain || !chains.includes(context.state.chain)) {
    context.state.chain = chains[0];
  }
  context.roundChainCursor = Math.max(0, Math.min(context.roundChainCursor, chains.length - 1));
}

function resetRoundWindow(context: AutoAnalysisContext): void {
  context.roundQueuedSinceRest = 0;
  context.roundRestUntilMs = 0;
}

function parseDateTimeLocal(value: string | null | undefined): { timestamp: number; label: string } | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const deadline = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(deadline.getTime())) return null;
  return {
    timestamp: deadline.getTime(),
    label: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function hasReachedConfiguredStopTime(stopAtDateTime: string | null | undefined, now = new Date()): { reached: boolean; label: string | null } {
  const parsed = parseDateTimeLocal(stopAtDateTime);
  if (!parsed) return { reached: false, label: null };
  return {
    reached: now.getTime() >= parsed.timestamp,
    label: parsed.label,
  };
}

function selectEligibleContracts(context: AutoAnalysisContext, chain: string, limit: number): ContractRegistryRow[] {
  const config = context.runtimeConfig;
  const contracts = listDashboardContractsRegistry(chain);
  if (!contracts.length) return [];

  const seenHashes = config.skipSeenContracts
    ? new Set(listDashboardSeenSelectors().map((entry) => entry.hash))
    : new Set<string>();
  const auditMap = getLatestContractAiAudits(chain, contracts.map((row) => row.contractAddr));
  const groups = new Map<string, ContractRegistryRow[]>();

  for (const row of contracts) {
    const selectorHash = row.selectorHash ?? null;
    if (config.requireContractSelectors && !row.selectors.length) continue;
    if (config.skipSeenContracts && selectorHash && seenHashes.has(selectorHash)) continue;
    const tvl = parsePortfolioUsd(row.portfolio);
    if (!Number.isFinite(tvl) || Number(tvl) < config.contractMinTvlUsd) continue;
    const groupKey = config.onePerContractPattern ? groupKeyForContract(row) : `contract:${row.contractAddr}`;
    const bucket = groups.get(groupKey) ?? [];
    bucket.push(row);
    groups.set(groupKey, bucket);
  }

  const selected: ContractRegistryRow[] = [];
  for (const rows of groups.values()) {
    rows.sort((a, b) => {
      const tvlDelta = (parsePortfolioUsd(b.portfolio) ?? -1) - (parsePortfolioUsd(a.portfolio) ?? -1);
      if (tvlDelta !== 0) return tvlDelta > 0 ? 1 : -1;
      return b.codeSize - a.codeSize;
    });
    const groupAlreadyHandled = config.excludeAuditedContracts
      ? rows.some((row) => (
        row.isAutoAudit
        || row.isManualAudit
        || shouldTreatAuditAsHandled(auditMap.get(row.contractAddr), config.retryFailedAudits)
      ))
      : rows.some((row) => shouldTreatAuditAsHandled(auditMap.get(row.contractAddr), config.retryFailedAudits));
    if (groupAlreadyHandled) continue;
    const representative = rows[0];
    const plan = getContractAiAuditPlan(chain, representative.contractAddr);
    if (!plan.accepted) continue;
    selected.push(representative);
  }

  selected.sort((a, b) => {
    const tvlDelta = (parsePortfolioUsd(b.portfolio) ?? -1) - (parsePortfolioUsd(a.portfolio) ?? -1);
    if (tvlDelta !== 0) return tvlDelta > 0 ? 1 : -1;
    return b.codeSize - a.codeSize;
  });

  return selected.slice(0, Math.max(0, limit));
}

function selectEligibleTokens(context: AutoAnalysisContext, chain: string, limit: number) {
  const config = context.runtimeConfig;
  const tokens = listDashboardStoredTokens(chain);
  if (!tokens.length) return [];
  const audits = getLatestTokenAiAudits(chain, tokens.map((row) => row.token));
  return tokens
    .filter((row) => row.tokenCallsSync === true || !config.requireTokenSync)
    .filter((row) => Number.isFinite(Number(row.priceUsd)) && Number(row.priceUsd) >= config.tokenMinPriceUsd)
    .filter((row) => (
      !config.excludeAuditedTokens
      || (
        !row.isAutoAudited
        && !row.isManualAudited
        && !shouldTreatAuditAsHandled(audits.get(row.token), config.retryFailedAudits)
      )
    ))
    .sort((a, b) => {
      const priceDelta = (Number(b.priceUsd) || -1) - (Number(a.priceUsd) || -1);
      if (priceDelta !== 0) return priceDelta > 0 ? 1 : -1;
      return String(a.token).localeCompare(String(b.token));
    })
    .slice(0, Math.max(0, limit));
}

function computeTargetSlots(context: AutoAnalysisContext, capacity: number) {
  const safeCapacity = Math.max(1, capacity);
  const tokenShare = Math.max(0, context.runtimeConfig.tokenSharePercent);
  const contractShare = Math.max(0, context.runtimeConfig.contractSharePercent);
  const totalShare = tokenShare + contractShare || 100;
  const contractSlots = Math.max(0, Math.round((safeCapacity * contractShare) / totalShare));
  const tokenSlots = Math.max(0, safeCapacity - contractSlots);
  return { contractSlots, tokenSlots };
}

function allocateSlotsByRatio(chains: string[], ratios: Record<string, number>, totalSlots: number): Map<string, number> {
  const allocations = new Map<string, number>();
  if (!chains.length || totalSlots <= 0) return allocations;
  const weighted = chains.map((chain) => ({
    chain,
    ratio: Math.max(1, Number(ratios[chain]) || 100),
  }));
  const ratioTotal = weighted.reduce((sum, entry) => sum + entry.ratio, 0) || weighted.length;
  let used = 0;
  const remainders = weighted.map((entry) => {
    const exact = (totalSlots * entry.ratio) / ratioTotal;
    const base = Math.floor(exact);
    allocations.set(entry.chain, base);
    used += base;
    return {
      chain: entry.chain,
      remainder: exact - base,
      ratio: entry.ratio,
    };
  });
  const remaining = Math.max(0, totalSlots - used);
  remainders
    .sort((a, b) => {
      if (b.remainder !== a.remainder) return b.remainder - a.remainder;
      return b.ratio - a.ratio;
    })
    .slice(0, remaining)
    .forEach((entry) => {
      allocations.set(entry.chain, (allocations.get(entry.chain) || 0) + 1);
    });
  return allocations;
}

function queueChainBatch(
  context: AutoAnalysisContext,
  chain: string,
  totalSlots: number,
): { used: number; queuedContracts: number; queuedTokens: number } {
  if (totalSlots <= 0) {
    return { used: 0, queuedContracts: 0, queuedTokens: 0 };
  }
  const targets = computeTargetSlots(context, totalSlots);
  const contractNeed = Math.max(0, Math.min(totalSlots, targets.contractSlots));
  const tokenNeed = Math.max(0, Math.min(totalSlots - contractNeed, targets.tokenSlots));
  const contractCandidates = selectEligibleContracts(context, chain, contractNeed);
  const tokenCandidates = selectEligibleTokens(context, chain, tokenNeed);

  let queuedContracts = 0;
  let queuedTokens = 0;

  for (const candidate of contractCandidates) {
    const row = requestContractAiAudit({
      chain,
      contractAddr: candidate.contractAddr,
      title: 'AI Auto Audit',
      provider: context.runtimeConfig.provider,
      model: context.runtimeConfig.model,
    });
    enqueueContractAiAudit(row, {
      backendApiKey: context.backendApiKey || null,
      ownerUsername: context.username,
    });
    queuedContracts += 1;
  }

  for (const candidate of tokenCandidates) {
    const row = requestTokenAiAudit({
      chain,
      tokenAddr: candidate.token,
      title: 'AI Auto Audit',
      provider: context.runtimeConfig.provider,
      model: context.runtimeConfig.model,
    });
    enqueueTokenAiAudit(row, {
      backendApiKey: context.backendApiKey || null,
      ownerUsername: context.username,
    });
    queuedTokens += 1;
  }

  return {
    used: queuedContracts + queuedTokens,
    queuedContracts,
    queuedTokens,
  };
}

async function fillAuditPool(context: AutoAnalysisContext): Promise<number> {
  recomputeWorkerCapacity();
  const worker = currentWorkerStatus(context);
  const globalAvailable = Math.max(0, worker.capacity - (getAiAuditWorkerStatus().queued + getAiAuditWorkerStatus().active));
  const personalCapacity = Math.max(1, context.runtimeConfig.queueCapacity);
  const ownInFlight = worker.queued + worker.active;
  const personalAvailable = Math.max(0, personalCapacity - ownInFlight);
  const availableSlots = Math.max(0, Math.min(globalAvailable, personalAvailable));
  if (!availableSlots) return 0;
  const chains = getConfiguredChains(context);
  if (!chains.length) return 0;
  const roundLimit = Math.max(1, context.runtimeConfig.roundAuditLimit);
  const roundRemaining = Math.max(0, roundLimit - context.roundQueuedSinceRest);
  if (!roundRemaining) return 0;
  const queueableSlots = Math.min(availableSlots, roundRemaining);
  if (!queueableSlots) return 0;

  let queuedContracts = 0;
  let queuedTokens = 0;
  const perChainQueued = new Map<string, number>();
  const allocations = allocateSlotsByRatio(chains, context.state.chainRatios, queueableSlots);
  let remainingSlots = queueableSlots;

  for (const chain of chains) {
    const allocation = allocations.get(chain) || 0;
    if (!allocation) continue;
    const result = queueChainBatch(context, chain, allocation);
    if (!result.used) continue;
    perChainQueued.set(chain, (perChainQueued.get(chain) || 0) + result.used);
    queuedContracts += result.queuedContracts;
    queuedTokens += result.queuedTokens;
    remainingSlots -= result.used;
  }

  if (remainingSlots > 0) {
    const refillOrder = [...chains].sort((a, b) => (context.state.chainRatios[b] || 0) - (context.state.chainRatios[a] || 0));
    for (const chain of refillOrder) {
      if (remainingSlots <= 0) break;
      const result = queueChainBatch(context, chain, remainingSlots);
      if (!result.used) continue;
      perChainQueued.set(chain, (perChainQueued.get(chain) || 0) + result.used);
      queuedContracts += result.queuedContracts;
      queuedTokens += result.queuedTokens;
      remainingSlots -= result.used;
    }
  }

  const used = queuedContracts + queuedTokens;
  if (!used) return 0;
  context.roundQueuedSinceRest = Math.min(roundLimit, context.roundQueuedSinceRest + used);
  const shouldRestAfterBatch = context.roundQueuedSinceRest >= roundLimit;
  if (shouldRestAfterBatch) {
    context.roundRestUntilMs = Date.now() + (Math.max(1, context.runtimeConfig.roundRestSeconds) * 1000);
  }

  const activeChain = [...perChainQueued.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || chains[0] || null;
  setStatus(context, {
    chain: activeChain,
    phase: 'auditing',
    lastAction: `Queued ${queuedContracts} contract / ${queuedTokens} token audit${used === 1 ? '' : 's'} across ${Array.from(perChainQueued.entries()).map(([chain, count]) => `${chain.toUpperCase()} x${count}`).join(', ')}${shouldRestAfterBatch ? `. Cooling down for ${Math.max(1, context.runtimeConfig.roundRestSeconds)}s after this batch` : ''}`,
  });
  return used;
}

async function runLoop(context: AutoAnalysisContext): Promise<void> {
  try {
    while (context.state.enabled || context.state.stopping) {
      syncContextChainState(context);
      const chains = getConfiguredChains(context);
      const chainSummary = describeChainSet(chains);
      const activeChain = context.state.chain;
      if (!chains.length) {
        setStatus(context, {
          enabled: false,
          stopping: false,
          phase: 'idle',
          lastAction: 'Auto analysis stopped: no auto chains selected',
        });
        return;
      }

      if (!context.state.enabled) {
        if (totalInFlight(context) > 0) {
          setStatus(context, {
            phase: 'draining',
            lastAction: `Draining ${totalInFlight(context)} in-flight audit${totalInFlight(context) === 1 ? '' : 's'} across ${chainSummary}`,
          });
          await sleep(LOOP_INTERVAL_MS);
          continue;
        }
        setStatus(context, {
          stopping: false,
          phase: 'idle',
          lastAction: 'Auto analysis stopped',
        });
        return;
      }

      if (!controls) {
        setStatus(context, {
          phase: 'idle',
          lastAction: 'Auto analysis controls not configured yet',
        });
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      const stopTimeState = hasReachedConfiguredStopTime(context.runtimeConfig.stopAtDateTime);
      if (stopTimeState.reached) {
        stopAutoAnalysis(
          context.username,
          stopTimeState.label ? `Auto analysis stop time ${stopTimeState.label} reached for ${chainSummary}` : 'Configured cutoff reached',
        );
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      if (controls.isRoundRunning()) {
        setStatus(context, {
          phase: 'round',
          lastAction: `Waiting for the current pipeline round to finish before scanning ${chainSummary}`,
        });
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      const now = Date.now();
      if (context.roundRestUntilMs > now) {
        const remainingSeconds = Math.max(1, Math.ceil((context.roundRestUntilMs - now) / 1000));
        setStatus(context, {
          phase: 'resting',
          lastAction: `Cooling down for ${remainingSeconds}s before the next auto-analysis batch across ${chainSummary}`,
        });
        await sleep(Math.min(LOOP_INTERVAL_MS, context.roundRestUntilMs - now));
        continue;
      }
      if (context.roundRestUntilMs > 0) {
        resetRoundWindow(context);
      }

      setStatus(context, {
        chain: activeChain || chains[0] || null,
        phase: 'screening',
        lastAction: `Scanning ${chainSummary} for eligible auto-analysis candidates`,
      });
      const enqueued = await fillAuditPool(context);
      if (enqueued > 0) {
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      if (totalInFlight(context) > 0) {
        setStatus(context, {
          phase: 'auditing',
          lastAction: `Watching ${totalInFlight(context)} in-flight audit${totalInFlight(context) === 1 ? '' : 's'} across ${chainSummary}`,
        });
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      if (!context.runtimeConfig.continueOnEmptyRound) {
        stopAutoAnalysis(context.username, `No eligible candidates left across ${chainSummary}. Auto analysis stopped because next-round continuation is disabled`);
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      const nextRoundChain = chains[context.roundChainCursor % chains.length] || chains[0];
      context.roundChainCursor = (context.roundChainCursor + 1) % Math.max(1, chains.length);

      setStatus(context, {
        chain: nextRoundChain,
        phase: 'round',
        lastAction: `No eligible candidates left across ${chainSummary}. Starting the next ${nextRoundChain.toUpperCase()} round`,
      });
      try {
        await controls.runRound(nextRoundChain);
        setStatus(context, {
          chain: nextRoundChain,
          cycle: context.state.cycle + 1,
          phase: 'screening',
          lastAction: `Round finished on ${nextRoundChain.toUpperCase()}. Screening ${chainSummary} again`,
        });
      } catch (error) {
        logger.error(`[auto-analysis] Round failed for ${context.username}/${nextRoundChain}`, error);
        setStatus(context, {
          chain: nextRoundChain,
          phase: 'idle',
          lastAction: `Round failed on ${nextRoundChain.toUpperCase()}: ${(error as Error).message}`,
        });
        await sleep(FAILURE_BACKOFF_MS);
      }
    }
  } finally {
    context.loopPromise = null;
    publish(context);
  }
}

function ensureLoop(context: AutoAnalysisContext): void {
  if (context.loopPromise) return;
  context.loopPromise = runLoop(context);
}

export function configureAutoAnalysisEngine(nextControls: AutoAnalysisControls): void {
  controls = nextControls;
}

export function getAutoAnalysisRuntimeConfig(username: string): AutoAnalysisRuntimeConfig {
  const context = ensureContext(username);
  syncContextChainState(context);
  return { ...context.runtimeConfig };
}

export function setAutoAnalysisRuntimeConfig(
  username: string,
  input: Partial<AutoAnalysisRuntimeConfig> | null | undefined,
): AutoAnalysisRuntimeConfig {
  const context = ensureContext(username);
  context.runtimeConfig = normalizeRuntimeConfig(input, context.runtimeConfig);
  syncContextChainState(context);
  recomputeWorkerCapacity();
  refreshWorkerStatus(context);
  publish(context);
  return { ...context.runtimeConfig };
}

export function getAutoAnalysisStatus(username: string): AutoAnalysisStatus {
  const context = ensureContext(username);
  syncContextChainState(context);
  refreshWorkerStatus(context);
  return { ...context.state };
}

export function subscribeAutoAnalysisStatus(listener: AutoAnalysisListener): () => void {
  listeners.add(listener);
  for (const context of contexts.values()) {
    void listener({
      username: context.username,
      ...getAutoAnalysisStatus(context.username),
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

export function startAutoAnalysis(
  username: string,
  options: { backendApiKey?: string | null; chains?: string[] | null } = {},
): AutoAnalysisStatus {
  const context = ensureContext(username);
  if (Array.isArray(options.chains)) {
    context.runtimeConfig = normalizeRuntimeConfig({
      selectedChains: options.chains,
    }, context.runtimeConfig);
  }
  syncContextChainState(context);
  const chains = getConfiguredChains(context);
  if (!chains.length) throw new Error('Auto analysis requires at least one chain');
  if (options.backendApiKey !== undefined) {
    context.backendApiKey = String(options.backendApiKey || '').trim();
  }
  resetRoundWindow(context);
  setStatus(context, {
    enabled: true,
    stopping: false,
    chain: chains[0],
    phase: 'screening',
    lastAction: `Auto analysis started across ${describeChainSet(chains)}`,
  });
  ensureLoop(context);
  return getAutoAnalysisStatus(username);
}

export function stopAutoAnalysis(username: string, reason?: string): AutoAnalysisStatus {
  const context = ensureContext(username);
  syncContextChainState(context);
  const inflight = totalInFlight(context);
  resetRoundWindow(context);
  const chainSummary = describeChainSet(getConfiguredChains(context));
  const message = reason
    ? (inflight > 0
      ? `${reason}. Letting ${inflight} in-flight audit${inflight === 1 ? '' : 's'} finish`
      : reason)
    : (inflight > 0
      ? `Stop requested for ${chainSummary}. Letting ${inflight} in-flight audit${inflight === 1 ? '' : 's'} finish`
      : 'Auto analysis stopped');
  setStatus(context, {
    enabled: false,
    stopping: inflight > 0,
    phase: inflight > 0 ? 'draining' : 'idle',
    lastAction: message,
  });
  if (inflight > 0) ensureLoop(context);
  return getAutoAnalysisStatus(username);
}

export function startAutoAnalysisEngine(): void {
  recomputeWorkerCapacity();
  for (const context of contexts.values()) {
    syncContextChainState(context);
    refreshWorkerStatus(context);
    publish(context);
  }
}

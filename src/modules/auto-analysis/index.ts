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

function normalizeTimeOfDay(value: unknown): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const match = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export interface AutoAnalysisStatus {
  enabled: boolean;
  stopping: boolean;
  chain: string | null;
  phase: AutoAnalysisPhase;
  queued: number;
  active: number;
  capacity: number;
  cycle: number;
  lastAction: string;
  updatedAt: string;
}

export interface AutoAnalysisRuntimeConfig {
  queueCapacity: number;
  roundAuditLimit: number;
  roundRestSeconds: number;
  stopAtTime: string | null;
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

type AutoAnalysisListener = (status: AutoAnalysisStatus) => void | Promise<void>;

const listeners = new Set<AutoAnalysisListener>();

const DEFAULT_AUTO_ANALYSIS_CONFIG: AutoAnalysisRuntimeConfig = {
  queueCapacity: 10,
  roundAuditLimit: 5,
  roundRestSeconds: 60,
  stopAtTime: null,
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

let runtimeConfig: AutoAnalysisRuntimeConfig = { ...DEFAULT_AUTO_ANALYSIS_CONFIG };

const persistedState = loadPersistedAutoAnalysisState();

const state: AutoAnalysisStatus = {
  enabled: persistedState.enabled,
  stopping: persistedState.stopping,
  chain: persistedState.chain,
  phase: persistedState.phase,
  queued: 0,
  active: 0,
  capacity: getAiAuditWorkerStatus().capacity,
  cycle: persistedState.cycle,
  lastAction: persistedState.lastAction,
  updatedAt: new Date().toISOString(),
};

let controls: AutoAnalysisControls | null = null;
let loopPromise: Promise<void> | null = null;
let roundQueuedSinceRest = 0;
let roundRestUntilMs = 0;

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

function persistState(): void {
  persistAutoAnalysisState({
    enabled: state.enabled,
    stopping: state.stopping,
    chain: state.chain,
    phase: state.phase,
    cycle: state.cycle,
    lastAction: state.lastAction,
  });
}

function refreshWorkerStatus(): void {
  const worker = getAiAuditWorkerStatus();
  state.queued = worker.queued;
  state.active = worker.active;
  state.capacity = worker.capacity;
}

function publish(): void {
  refreshWorkerStatus();
  state.updatedAt = new Date().toISOString();
  for (const listener of listeners) {
    try {
      void listener({ ...state });
    } catch {
      // no-op
    }
  }
}

function normalizeRuntimeConfig(input: Partial<AutoAnalysisRuntimeConfig> | null | undefined): AutoAnalysisRuntimeConfig {
  const merged = {
    ...DEFAULT_AUTO_ANALYSIS_CONFIG,
    ...runtimeConfig,
    ...(input || {}),
  };
  const provider = normalizeAiAuditProvider(merged.provider);
  return {
    queueCapacity: parsePositiveInt(merged.queueCapacity, DEFAULT_AUTO_ANALYSIS_CONFIG.queueCapacity),
    roundAuditLimit: parsePositiveInt(merged.roundAuditLimit, DEFAULT_AUTO_ANALYSIS_CONFIG.roundAuditLimit),
    roundRestSeconds: parsePositiveInt(merged.roundRestSeconds, DEFAULT_AUTO_ANALYSIS_CONFIG.roundRestSeconds),
    stopAtTime: normalizeTimeOfDay(merged.stopAtTime),
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

function getRuntimeConfig(): AutoAnalysisRuntimeConfig {
  return runtimeConfig;
}

function setStatus(patch: Partial<AutoAnalysisStatus>): void {
  Object.assign(state, patch);
  persistState();
  publish();
}

function totalInFlight(): number {
  refreshWorkerStatus();
  return state.queued + state.active;
}

function currentWorkerStatus() {
  const worker = getAiAuditWorkerStatus();
  state.queued = worker.queued;
  state.active = worker.active;
  state.capacity = worker.capacity;
  return worker;
}

function resetRoundWindow(): void {
  roundQueuedSinceRest = 0;
  roundRestUntilMs = 0;
}

function parseTimeOfDay(value: string | null | undefined): { hour: number; minute: number; label: string } | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  const match = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return {
    hour,
    minute,
    label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function hasReachedConfiguredStopTime(stopAtTime: string | null | undefined, now = new Date()): { reached: boolean; label: string | null } {
  const parsed = parseTimeOfDay(stopAtTime);
  if (!parsed) return { reached: false, label: null };
  const deadline = new Date(now);
  deadline.setHours(parsed.hour, parsed.minute, 0, 0);
  return {
    reached: now.getTime() >= deadline.getTime(),
    label: parsed.label,
  };
}

function selectEligibleContracts(chain: string, limit: number): ContractRegistryRow[] {
  const config = getRuntimeConfig();
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

function selectEligibleTokens(chain: string, limit: number) {
  const config = getRuntimeConfig();
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

function computeTargetSlots(capacity: number) {
  const config = getRuntimeConfig();
  const safeCapacity = Math.max(1, capacity);
  const tokenShare = Math.max(0, config.tokenSharePercent);
  const contractShare = Math.max(0, config.contractSharePercent);
  const totalShare = tokenShare + contractShare || 100;
  const contractSlots = Math.max(0, Math.round((safeCapacity * contractShare) / totalShare));
  const tokenSlots = Math.max(0, safeCapacity - contractSlots);
  return { contractSlots, tokenSlots };
}

async function fillAuditPool(chain: string): Promise<number> {
  const config = getRuntimeConfig();
  setAiAuditWorkerCapacity(config.queueCapacity);
  const worker = currentWorkerStatus();
  const availableSlots = Math.max(0, worker.capacity - (worker.queued + worker.active));
  if (!availableSlots) return 0;
  const roundLimit = Math.max(1, config.roundAuditLimit);
  const roundRemaining = Math.max(0, roundLimit - roundQueuedSinceRest);
  if (!roundRemaining) return 0;
  const queueableSlots = Math.min(availableSlots, roundRemaining);
  if (!queueableSlots) return 0;

  const targets = computeTargetSlots(queueableSlots);
  const contractNeed = Math.max(0, Math.min(queueableSlots, targets.contractSlots));
  const tokenNeed = Math.max(0, Math.min(queueableSlots - contractNeed, targets.tokenSlots));

  const contractCandidates = selectEligibleContracts(chain, contractNeed);
  const tokenCandidates = selectEligibleTokens(chain, tokenNeed);

  let queuedContracts = 0;
  let queuedTokens = 0;

  for (const candidate of contractCandidates) {
    const row = requestContractAiAudit({
      chain,
      contractAddr: candidate.contractAddr,
      title: 'AI Auto Audit',
      provider: config.provider,
      model: config.model,
    });
    enqueueContractAiAudit(row);
    queuedContracts += 1;
  }

  for (const candidate of tokenCandidates) {
    const row = requestTokenAiAudit({
      chain,
      tokenAddr: candidate.token,
      title: 'AI Auto Audit',
      provider: config.provider,
      model: config.model,
    });
    enqueueTokenAiAudit(row);
    queuedTokens += 1;
  }

  const used = queuedContracts + queuedTokens;
  if (!used) return 0;
  roundQueuedSinceRest = Math.min(roundLimit, roundQueuedSinceRest + used);
  const shouldRestAfterBatch = roundQueuedSinceRest >= roundLimit;
  if (shouldRestAfterBatch) {
    roundRestUntilMs = Date.now() + (Math.max(1, config.roundRestSeconds) * 1000);
  }

  setStatus({
    phase: 'auditing',
    lastAction: `Queued ${queuedContracts} contract / ${queuedTokens} token audit${used === 1 ? '' : 's'} on ${chain.toUpperCase()}${shouldRestAfterBatch ? `. Cooling down for ${Math.max(1, config.roundRestSeconds)}s after this batch` : ''}`,
  });
  return used;
}

async function runLoop(): Promise<void> {
  try {
    while (state.enabled || state.stopping) {
      const chain = state.chain;
      if (!chain) {
        setStatus({
          enabled: false,
          stopping: false,
          phase: 'idle',
          lastAction: 'Auto analysis stopped: no chain selected',
        });
        persistState();
        return;
      }

      if (!state.enabled) {
        if (totalInFlight() > 0) {
          setStatus({
            phase: 'draining',
            lastAction: `Draining ${totalInFlight()} in-flight audit${totalInFlight() === 1 ? '' : 's'} on ${chain.toUpperCase()}`,
          });
          await sleep(LOOP_INTERVAL_MS);
          continue;
        }
        setStatus({
          stopping: false,
          phase: 'idle',
          lastAction: 'Auto analysis stopped',
        });
        return;
      }

      if (!controls) {
        setStatus({
          phase: 'idle',
          lastAction: 'Auto analysis controls not configured yet',
        });
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      const stopTimeState = hasReachedConfiguredStopTime(getRuntimeConfig().stopAtTime);
      if (stopTimeState.reached) {
        stopAutoAnalysis(`Auto analysis stop time ${stopTimeState.label || 'configured cutoff'} reached on ${chain.toUpperCase()}`);
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      if (controls.isRoundRunning()) {
        setStatus({
          phase: 'round',
          lastAction: `Waiting for the current ${chain.toUpperCase()} round to finish`,
        });
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      const now = Date.now();
      if (roundRestUntilMs > now) {
        const remainingSeconds = Math.max(1, Math.ceil((roundRestUntilMs - now) / 1000));
        setStatus({
          phase: 'resting',
          lastAction: `Cooling down for ${remainingSeconds}s before the next auto-analysis batch on ${chain.toUpperCase()}`,
        });
        await sleep(Math.min(LOOP_INTERVAL_MS, roundRestUntilMs - now));
        continue;
      }
      if (roundRestUntilMs > 0) {
        resetRoundWindow();
      }

      setStatus({
        phase: 'screening',
        lastAction: `Scanning ${chain.toUpperCase()} for eligible auto-analysis candidates`,
      });
      const enqueued = await fillAuditPool(chain);
      if (enqueued > 0) {
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      if (totalInFlight() > 0) {
        setStatus({
          phase: 'auditing',
          lastAction: `Watching ${totalInFlight()} in-flight audit${totalInFlight() === 1 ? '' : 's'} on ${chain.toUpperCase()}`,
        });
        await sleep(LOOP_INTERVAL_MS);
        continue;
      }

      setStatus({
        phase: 'round',
        lastAction: `No eligible contracts left on ${chain.toUpperCase()}. Starting the next round`,
      });
      try {
        await controls.runRound(chain);
        setStatus({
          cycle: state.cycle + 1,
          phase: 'screening',
          lastAction: `Round finished on ${chain.toUpperCase()}. Screening new contracts`,
        });
      } catch (error) {
        logger.error(`[auto-analysis] Round failed for ${chain}`, error);
        setStatus({
          phase: 'idle',
          lastAction: `Round failed on ${chain.toUpperCase()}: ${(error as Error).message}`,
        });
        await sleep(FAILURE_BACKOFF_MS);
      }
    }
  } finally {
    loopPromise = null;
    publish();
  }
}

function ensureLoop(): void {
  if (loopPromise) return;
  loopPromise = runLoop();
}

export function configureAutoAnalysisEngine(nextControls: AutoAnalysisControls): void {
  controls = nextControls;
}

export function getAutoAnalysisRuntimeConfig(): AutoAnalysisRuntimeConfig {
  return { ...runtimeConfig };
}

export function setAutoAnalysisRuntimeConfig(input: Partial<AutoAnalysisRuntimeConfig> | null | undefined): AutoAnalysisRuntimeConfig {
  runtimeConfig = normalizeRuntimeConfig(input);
  setAiAuditWorkerCapacity(runtimeConfig.queueCapacity);
  refreshWorkerStatus();
  publish();
  return getAutoAnalysisRuntimeConfig();
}

export function getAutoAnalysisStatus(): AutoAnalysisStatus {
  refreshWorkerStatus();
  return { ...state };
}

export function subscribeAutoAnalysisStatus(listener: AutoAnalysisListener): () => void {
  listeners.add(listener);
  void listener({ ...getAutoAnalysisStatus() });
  return () => {
    listeners.delete(listener);
  };
}

export function startAutoAnalysis(chain: string): AutoAnalysisStatus {
  const normalizedChain = String(chain || '').trim().toLowerCase();
  if (!normalizedChain) {
    throw new Error('Auto analysis requires a chain');
  }
  resetRoundWindow();
  setStatus({
    enabled: true,
    stopping: false,
    chain: normalizedChain,
    phase: 'screening',
    lastAction: `Auto analysis started on ${normalizedChain.toUpperCase()}`,
  });
  persistState();
  ensureLoop();
  return getAutoAnalysisStatus();
}

export function stopAutoAnalysis(reason?: string): AutoAnalysisStatus {
  const inflight = totalInFlight();
  resetRoundWindow();
  const message = reason
    ? (inflight > 0
      ? `${reason}. Letting ${inflight} in-flight audit${inflight === 1 ? '' : 's'} finish`
      : reason)
    : (inflight > 0
      ? `Stop requested. Letting ${inflight} in-flight audit${inflight === 1 ? '' : 's'} finish`
      : 'Auto analysis stopped');
  setStatus({
    enabled: false,
    stopping: inflight > 0,
    phase: inflight > 0 ? 'draining' : 'idle',
    lastAction: message,
  });
  persistState();
  if (inflight > 0) ensureLoop();
  return getAutoAnalysisStatus();
}

export function startAutoAnalysisEngine(): void {
  runtimeConfig = normalizeRuntimeConfig(runtimeConfig);
  const config = getRuntimeConfig();
  setAiAuditWorkerCapacity(config.queueCapacity);
  refreshWorkerStatus();
  publish();
}

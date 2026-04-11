import {
  getAppSetting,
  getLatestContractAiAudits,
  getLatestTokenAiAudits,
  requestContractAiAudit,
  requestTokenAiAudit,
  setManyAppSettings,
  type ContractRegistryRow,
} from '../../db.js';
import { getAutoAnalysisConfig } from '../../config.js';
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

const LOOP_INTERVAL_MS = 2_500;
const FAILURE_BACKOFF_MS = 10_000;

type AutoAnalysisPhase = 'idle' | 'screening' | 'auditing' | 'round' | 'draining';

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

interface AutoAnalysisControls {
  runRound: (chain: string) => Promise<unknown>;
  isRoundRunning: () => boolean;
}

type AutoAnalysisListener = (status: AutoAnalysisStatus) => void | Promise<void>;

const listeners = new Set<AutoAnalysisListener>();

const state: AutoAnalysisStatus = {
  enabled: false,
  stopping: false,
  chain: null,
  phase: 'idle',
  queued: 0,
  active: 0,
  capacity: getAiAuditWorkerStatus().capacity,
  cycle: 0,
  lastAction: 'Auto analysis is idle',
  updatedAt: new Date().toISOString(),
};

let controls: AutoAnalysisControls | null = null;
let loopPromise: Promise<void> | null = null;

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

function persistState(): void {
  setManyAppSettings([
    { key: 'auto_analysis.enabled', value: state.enabled ? '1' : '0' },
    { key: 'auto_analysis.chain', value: state.chain ?? '' },
  ]);
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

function setStatus(patch: Partial<AutoAnalysisStatus>): void {
  Object.assign(state, patch);
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

function selectEligibleContracts(chain: string, limit: number): ContractRegistryRow[] {
  const config = getAutoAnalysisConfig();
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
      ? rows.some((row) => row.isAutoAudit || row.isManualAudit || auditMap.has(row.contractAddr))
      : rows.some((row) => auditMap.has(row.contractAddr));
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
  const config = getAutoAnalysisConfig();
  const tokens = listDashboardStoredTokens(chain);
  if (!tokens.length) return [];
  const audits = getLatestTokenAiAudits(chain, tokens.map((row) => row.token));
  return tokens
    .filter((row) => row.tokenCallsSync === true || !config.requireTokenSync)
    .filter((row) => Number.isFinite(Number(row.priceUsd)) && Number(row.priceUsd) >= config.tokenMinPriceUsd)
    .filter((row) => !config.excludeAuditedTokens || (!row.isAutoAudited && !row.isManualAudited && !audits.has(row.token)))
    .sort((a, b) => {
      const priceDelta = (Number(b.priceUsd) || -1) - (Number(a.priceUsd) || -1);
      if (priceDelta !== 0) return priceDelta > 0 ? 1 : -1;
      return String(a.token).localeCompare(String(b.token));
    })
    .slice(0, Math.max(0, limit));
}

function computeTargetSlots(capacity: number) {
  const config = getAutoAnalysisConfig();
  const safeCapacity = Math.max(1, capacity);
  const tokenShare = Math.max(0, config.tokenSharePercent);
  const contractShare = Math.max(0, config.contractSharePercent);
  const totalShare = tokenShare + contractShare || 100;
  const contractSlots = Math.max(0, Math.round((safeCapacity * contractShare) / totalShare));
  const tokenSlots = Math.max(0, safeCapacity - contractSlots);
  return { contractSlots, tokenSlots };
}

async function fillAuditPool(chain: string): Promise<number> {
  const config = getAutoAnalysisConfig();
  setAiAuditWorkerCapacity(config.queueCapacity);
  const worker = currentWorkerStatus();
  const availableSlots = Math.max(0, worker.capacity - (worker.queued + worker.active));
  if (!availableSlots) return 0;

  const targets = computeTargetSlots(worker.capacity);
  const contractNeed = Math.max(0, targets.contractSlots - (worker.queuedContracts + worker.activeContracts));
  const tokenNeed = Math.max(0, targets.tokenSlots - (worker.queuedTokens + worker.activeTokens));

  const contractCandidates = selectEligibleContracts(chain, contractNeed);
  const tokenCandidates = selectEligibleTokens(chain, tokenNeed);

  let queuedContracts = 0;
  let queuedTokens = 0;

  for (const candidate of contractCandidates) {
    const row = requestContractAiAudit({
      chain,
      contractAddr: candidate.contractAddr,
      title: 'AI Auto Audit',
    });
    enqueueContractAiAudit(row);
    queuedContracts += 1;
  }

  for (const candidate of tokenCandidates) {
    const row = requestTokenAiAudit({
      chain,
      tokenAddr: candidate.token,
      title: 'AI Auto Audit',
    });
    enqueueTokenAiAudit(row);
    queuedTokens += 1;
  }

  const used = queuedContracts + queuedTokens;
  if (!used) return 0;

  setStatus({
    phase: 'auditing',
    lastAction: `Queued ${queuedContracts} contract / ${queuedTokens} token audit${used === 1 ? '' : 's'} on ${chain.toUpperCase()}`,
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

      if (controls.isRoundRunning()) {
        setStatus({
          phase: 'round',
          lastAction: `Waiting for the current ${chain.toUpperCase()} round to finish`,
        });
        await sleep(LOOP_INTERVAL_MS);
        continue;
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

export function stopAutoAnalysis(): AutoAnalysisStatus {
  const inflight = totalInFlight();
  setStatus({
    enabled: false,
    stopping: inflight > 0,
    phase: inflight > 0 ? 'draining' : 'idle',
    lastAction: inflight > 0
      ? `Stop requested. Letting ${inflight} in-flight audit${inflight === 1 ? '' : 's'} finish`
      : 'Auto analysis stopped',
  });
  persistState();
  if (inflight > 0) ensureLoop();
  return getAutoAnalysisStatus();
}

export function startAutoAnalysisEngine(): void {
  const enabled = getAppSetting('auto_analysis.enabled') === '1';
  const chain = String(getAppSetting('auto_analysis.chain') || '').trim().toLowerCase();
  const config = getAutoAnalysisConfig();
  setAiAuditWorkerCapacity(config.queueCapacity);
  refreshWorkerStatus();
  publish();
  if (enabled && chain) {
    logger.info(`[auto-analysis] Restoring auto analysis mode for ${chain}`);
    startAutoAnalysis(chain);
  }
}

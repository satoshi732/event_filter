import { Client } from 'pg';
import {
  findReviewTarget,
  getPatternSyncState,
  getSeenContractQueueCounts,
  getSeenContractsForPush,
  saveSeenSelectorPattern,
  markSeenContractPushResult,
  upsertSeenContractReview,
  updatePatternSyncState,
} from './repository.js';
import { getPatternSyncConfig } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { selectorHash } from '../../utils/selector-pattern.js';
import { getContractsRegistry, upsertContractsRegistryBatch } from '../../db/contracts.js';

interface RemotePatternRow {
  hash: string;
  label: string;
  selectors: string[];
  bytecode_size: number;
  created_at: string;
}

export interface PatternSyncStatus {
  configured: boolean;
  remoteName: string | null;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastVerifyAt: string | null;
  queue: Record<string, number>;
}

export interface PatternSyncEvent {
  kind: 'pull' | 'push' | 'verify';
  result: Record<string, unknown>;
  status: PatternSyncStatus;
  ts: string;
}

const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const REMOTE_SYNC_CONNECT_TIMEOUT_MS = 5_000;
let autoSyncTimer: NodeJS.Timeout | null = null;
let autoSyncRunning = false;
const listeners = new Set<(event: PatternSyncEvent) => void | Promise<void>>();

function getConfigOrThrow() {
  const config = getPatternSyncConfig();
  if (!config) throw new Error('Pattern sync is not configured');
  return config;
}

function normalizeSelector(selector: string): string {
  const value = selector.trim().toLowerCase().replace(/^0x/, '');
  if (!value) throw new Error('Empty selector');
  return `0x${value}`;
}

function normalizeSelectors(selectors: string[]): string[] {
  return [...new Set(selectors.map(normalizeSelector))].sort();
}

async function publishPatternSyncEvent(kind: PatternSyncEvent['kind'], result: Record<string, unknown>): Promise<void> {
  const status = await getPatternSyncStatus();
  const payload: PatternSyncEvent = {
    kind,
    result,
    status,
    ts: new Date().toISOString(),
  };
  for (const listener of listeners) {
    try {
      await listener(payload);
    } catch {
      // no-op
    }
  }
}

async function withRemoteClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const config = getConfigOrThrow();
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: REMOTE_SYNC_CONNECT_TIMEOUT_MS,
    query_timeout: REMOTE_SYNC_CONNECT_TIMEOUT_MS,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS patterns (
        hash TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        selectors TEXT[] NOT NULL,
        bytecode_size INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_patterns_hash ON patterns (hash);`);
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function queueSeenPattern(label: string, selectors: string[], bytecodeSize = 0): string {
  const normalized = normalizeSelectors(selectors);
  const hash = selectorHash(normalized);
  upsertSeenContractReview({
    chain: 'global',
    contractAddress: `pattern:${hash}`,
    patternHash: hash,
    patternKind: 'pattern',
    patternAddress: `pattern:${hash}`,
    label,
    reviewText: '',
    exploitable: false,
    selectors: normalized,
    bytecodeSize,
  });
  return hash;
}

export function queueSeenContractReviewTarget(chain: string, address: string, label: string, targetKind = 'auto'): string {
  const entry = findReviewTarget(chain, address, targetKind);
  if (!entry) {
    throw new Error(`Contract ${address} (${targetKind}) not found in selectors registry`);
  }
  const normalized = normalizeSelectors(entry.selectors ?? []);
  const hash = entry.patternHash || selectorHash(normalized);
  upsertSeenContractReview({
    chain,
    contractAddress: entry.ownerAddress,
    patternHash: hash,
    patternKind: entry.targetKind,
    patternAddress: entry.targetAddress,
    label,
    reviewText: '',
    exploitable: false,
    selectors: normalized,
    bytecodeSize: entry.bytecodeSize ?? 0,
  });
  return hash;
}

export function saveSeenContractReview(input: {
  chain: string;
  address: string;
  label: string;
  reviewText?: string;
  exploitable?: boolean;
  targetKind?: string;
}): string {
  const entry = findReviewTarget(input.chain, input.address, input.targetKind ?? 'auto');
  if (!entry) {
    throw new Error(`Contract ${input.address} (${input.targetKind ?? 'auto'}) not found in selectors registry`);
  }

  const normalized = normalizeSelectors(entry.selectors ?? []);
  const hash = entry.patternHash || selectorHash(normalized);
  upsertSeenContractReview({
    chain: input.chain,
    contractAddress: entry.ownerAddress,
    patternHash: hash,
    patternKind: entry.targetKind,
    patternAddress: entry.targetAddress,
    label: input.label,
    reviewText: input.reviewText ?? '',
    exploitable: input.exploitable ?? false,
    selectors: normalized,
    bytecodeSize: entry.bytecodeSize ?? 0,
  });
  return hash;
}

export function saveContractReview(input: {
  chain: string;
  address: string;
  label: string;
  reviewText?: string;
  exploitable?: boolean;
  targetKind?: string;
}): { hash: string | null; persistedOnly: boolean } {
  const targetAddress = String(input.address || '').trim().toLowerCase();
  const chain = String(input.chain || '').trim().toLowerCase();
  const targetKind = input.targetKind ?? 'auto';
  const label = String(input.label || '').trim();
  const reviewText = input.reviewText ?? '';
  const exploitable = Boolean(input.exploitable);

  const entry = findReviewTarget(chain, targetAddress, targetKind);
  if (entry) {
    const hash = saveSeenContractReview({
      chain,
      address: targetAddress,
      label,
      reviewText,
      exploitable,
      targetKind,
    });
    return { hash, persistedOnly: false };
  }

  const registry = getContractsRegistry(chain, [targetAddress]).get(targetAddress);
  upsertContractsRegistryBatch(chain, [{
    contractAddr: targetAddress,
    linkage: registry?.linkage ?? null,
    linkType: registry?.linkType ?? null,
    label,
    review: reviewText,
    selectorHash: registry?.selectorHash ?? null,
    isExploitable: exploitable,
    portfolio: registry?.portfolio ?? '{}',
    deployedAt: registry?.deployedAt ?? null,
    isAutoAudit: registry?.isAutoAudit ?? false,
    isManualAudit: true,
    whitelistPatterns: registry?.whitelistPatterns ?? [],
    selectors: registry?.selectors ?? [],
    codeSize: registry?.codeSize ?? 0,
  }]);

  return {
    hash: registry?.selectorHash ?? null,
    persistedOnly: true,
  };
}

export async function pullPatterns(): Promise<{ pulled: number; lastPullAt: string | null }> {
  const config = getConfigOrThrow();
  const state = getPatternSyncState(config.remoteName);
  const rows = await withRemoteClient(async (client) => {
    const result = state.lastPullAt
      ? await client.query<RemotePatternRow>(
          `SELECT hash, label, selectors, bytecode_size, created_at
           FROM patterns
           WHERE created_at > $1
           ORDER BY created_at ASC`,
          [state.lastPullAt],
        )
      : await client.query<RemotePatternRow>(
          `SELECT hash, label, selectors, bytecode_size, created_at
           FROM patterns
           ORDER BY created_at ASC`,
        );
    return result.rows;
  });

  let highest = state.lastPullAt;
  for (const row of rows) {
    const selectors = normalizeSelectors(row.selectors ?? []);
    saveSeenSelectorPattern(selectors, row.label ?? '', row.bytecode_size ?? 0);
    const createdAt = row.created_at ? new Date(row.created_at).toISOString() : null;
    if (createdAt && (!highest || createdAt > highest)) highest = createdAt;
  }

  if (highest) updatePatternSyncState(config.remoteName, { lastPullAt: highest });
  const result = { pulled: rows.length, lastPullAt: highest };
  void publishPatternSyncEvent('pull', result);
  return result;
}

export async function pushPatterns(): Promise<{ pushed: number; failed: number }> {
  return pushPatternsByStatuses(['prepared']);
}

async function pushPatternsByStatuses(statuses: string[]): Promise<{ pushed: number; failed: number }> {
  const config = getConfigOrThrow();
  const queue = getSeenContractsForPush(statuses);
  if (!queue.length) return { pushed: 0, failed: 0 };

  let pushed = 0;
  let failed = 0;

  await withRemoteClient(async (client) => {
    for (const item of queue) {
      try {
        await client.query(
          `INSERT INTO patterns (hash, label, selectors, bytecode_size)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (hash) DO UPDATE SET
             label = EXCLUDED.label,
             selectors = EXCLUDED.selectors,
             bytecode_size = EXCLUDED.bytecode_size`,
          [item.hash, item.label, item.selectors, item.bytecodeSize],
        );
        markSeenContractPushResult(item.hash, 'synced', null);
        pushed += 1;
      } catch (err) {
        markSeenContractPushResult(item.hash, 'failed', err instanceof Error ? err.message : String(err));
        failed += 1;
      }
    }
  });

  if (pushed) updatePatternSyncState(config.remoteName, { lastPushAt: new Date().toISOString() });
  const result = { pushed, failed };
  void publishPatternSyncEvent('push', result);
  return result;
}

export async function verifyPatterns(): Promise<{ checked: number; mismatches: Array<{ hash: string; computedHash: string; label: string }> }> {
  const config = getConfigOrThrow();
  const state = getPatternSyncState(config.remoteName);
  const rows = await withRemoteClient(async (client) => {
    const result = state.lastVerifyAt
      ? await client.query<RemotePatternRow>(
          `SELECT hash, label, selectors, bytecode_size, created_at
           FROM patterns
           WHERE created_at > $1
           ORDER BY created_at ASC`,
          [state.lastVerifyAt],
        )
      : await client.query<RemotePatternRow>(
          `SELECT hash, label, selectors, bytecode_size, created_at
           FROM patterns
           ORDER BY created_at ASC`,
        );
    return result.rows;
  });

  const mismatches: Array<{ hash: string; computedHash: string; label: string }> = [];
  let highest = state.lastVerifyAt;
  for (const row of rows) {
    const normalized = normalizeSelectors(row.selectors ?? []);
    const computedHash = selectorHash(normalized);
    if (computedHash !== row.hash) {
      mismatches.push({
        hash: row.hash,
        computedHash,
        label: row.label ?? '',
      });
    }
    const createdAt = row.created_at ? new Date(row.created_at).toISOString() : null;
    if (createdAt && (!highest || createdAt > highest)) highest = createdAt;
  }

  if (highest) updatePatternSyncState(config.remoteName, { lastVerifyAt: highest });
  const result = { checked: rows.length, mismatches };
  void publishPatternSyncEvent('verify', { checked: result.checked, mismatches: result.mismatches });
  return result;
}

export async function getPatternSyncStatus(): Promise<PatternSyncStatus> {
  const config = getPatternSyncConfig();
  if (!config) {
    return {
      configured: false,
      remoteName: null,
      lastPullAt: null,
      lastPushAt: null,
      lastVerifyAt: null,
      queue: getSeenContractQueueCounts(),
    };
  }

  const state = getPatternSyncState(config.remoteName);
  return {
    configured: true,
    remoteName: config.remoteName,
    lastPullAt: state.lastPullAt,
    lastPushAt: state.lastPushAt,
    lastVerifyAt: state.lastVerifyAt,
    queue: getSeenContractQueueCounts(),
  };
}

export async function maybeAutoPullPatterns(): Promise<void> {
  const config = getPatternSyncConfig();
  if (!config?.autoPull) return;

  try {
    const result = await pullPatterns();
    logger.info(`[pattern-sync] Pulled ${result.pulled} remote pattern(s)`);
  } catch (err) {
    logger.warn(`[pattern-sync] Auto-pull failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runAutoSyncCycle(): Promise<void> {
  const config = getPatternSyncConfig();
  if (!config) return;
  if (autoSyncRunning) {
    logger.debug('[pattern-sync] Auto sync skipped: previous cycle still running');
    return;
  }

  autoSyncRunning = true;
  try {
    const pushResult = await pushPatternsByStatuses(['prepared']);
    const pullResult = await pullPatterns();
    logger.info(
      `[pattern-sync] Auto sync complete (push prepared: ${pushResult.pushed}, failed: ${pushResult.failed}; pulled: ${pullResult.pulled})`,
    );
  } catch (err) {
    logger.warn(`[pattern-sync] Auto sync failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    autoSyncRunning = false;
  }
}

export function startAutoPatternSyncLoop(intervalMs = AUTO_SYNC_INTERVAL_MS): void {
  if (autoSyncTimer) return;

  const config = getPatternSyncConfig();
  if (!config) {
    logger.info('[pattern-sync] Auto sync disabled: sync config missing');
    return;
  }

  const tick = () => {
    runAutoSyncCycle().catch((err) => {
      logger.warn(`[pattern-sync] Auto sync tick failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  tick();
  autoSyncTimer = setInterval(tick, intervalMs);
  logger.info(`[pattern-sync] Auto sync loop started (every ${Math.floor(intervalMs / 60000)} minutes)`);
}

export function subscribePatternSyncEvents(
  listener: (event: PatternSyncEvent) => void | Promise<void>,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

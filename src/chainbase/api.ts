import axios from 'axios';
import { logger } from '../utils/logger.js';

const BASE_URL    = 'https://api.chainbase.com/api/v1';
const EXECUTE_URL = `${BASE_URL}/query/execute`;
const RATE_LIMIT    = 61_000;  // normal cooldown between uses of the same key
const PENALTY_429   = 120_000; // 429 rate-limit penalty — skip key for 2 min

let apiKeys: string[]              = [];
let keyPtr   = 0;
let ready    = false;
const nextAt = new Map<string, number>();

// ── Init (idempotent) ─────────────────────────────────────────────────────────
export function initApiKeys(keys: string[]): void {
  if (ready) return;
  if (keys.length === 0) throw new Error('No Chainbase API keys configured');
  apiKeys = [...keys];
  keyPtr  = 0;
  ready   = true;
  keys.forEach(k => nextAt.set(k, 0));
  logger.info(`API keys initialised (${keys.length})`);
}

// ── Key rotation ──────────────────────────────────────────────────────────────
async function acquireKey(): Promise<string> {
  if (!apiKeys.length) throw new Error('Chainbase API not initialised');
  const now = Date.now();

  for (let i = 0; i < apiKeys.length; i++) {
    const k = apiKeys[keyPtr];
    keyPtr = (keyPtr + 1) % apiKeys.length;
    if (now >= (nextAt.get(k) ?? 0)) return k;
  }

  // All keys busy — wait for the soonest
  const soonest = Math.min(...Array.from(nextAt.values()));
  const wait    = soonest - now;
  logger.info(`All keys busy, waiting ${Math.ceil(wait / 1000)} s…`);
  await sleep(wait);

  return apiKeys.find(k => Date.now() >= (nextAt.get(k) ?? 0)) ?? apiKeys[0];
}

function releaseKey(k: string): void {
  nextAt.set(k, Date.now() + RATE_LIMIT);
}

function penalizeKey(k: string): void {
  nextAt.set(k, Date.now() + PENALTY_429);
  logger.warn(`  Key …${k.slice(-6)} 429 rate-limit — penalized for ${PENALTY_429 / 1000}s`);
}

function isRateLimited(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { response?: { status?: number } }).response?.status === 429;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Transient network error detection ────────────────────────────────────────
function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = (err as Error).message ?? '';
  // axios network errors: stream aborted, socket hang up, ECONNRESET, ETIMEDOUT
  const codes = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ERR_STREAM_DESTROYED'];
  if ('code' in err && codes.includes((err as NodeJS.ErrnoException).code ?? '')) return true;
  return /stream.*aborted|socket hang up|network error|ECONNRESET|ETIMEDOUT/i.test(msg);
}

// ── Poll execution status ─────────────────────────────────────────────────────
async function pollStatus(execId: string, key: string, maxAttempts = 90): Promise<void> {
  const TERMINAL = new Set(['COMPLETED', 'SUCCESS', 'SUCCEEDED', 'FINISHED']);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await axios.get(`${BASE_URL}/execution/${execId}/status`, {
      headers: { 'X-API-KEY': key },
      timeout: 15_000,
    });
    if (res.data?.code === 200 && res.data?.data?.length) {
      const { status, progress, message } = res.data.data[0];
      logger.debug(`  poll ${attempt}/${maxAttempts} status=${status} progress=${progress}%`);
      if (TERMINAL.has(status)) return;
      if (status === 'FAILED') throw new Error(`Query failed: ${message ?? 'unknown'}`);
    }
    await sleep(2_000);
  }
  throw new Error('Query execution timeout');
}

// ── Execute one attempt (submit → poll → fetch) ───────────────────────────────
async function executeOnce<T>(sql: string, key: string): Promise<T[]> {
  // 1. Submit
  const submitRes = await axios.post(EXECUTE_URL, { sql }, {
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    timeout: 30_000,
  });
  if (submitRes.data?.code !== 200 || !submitRes.data?.data?.length) {
    throw new Error(`Submit failed: ${submitRes.data?.message}`);
  }
  const execId: string = submitRes.data.data[0].executionId;
  logger.debug(`  execId=${execId}`);

  // 2. Poll
  await pollStatus(execId, key);

  // 3. Fetch results (generous timeout — large pages can be several MB)
  const resultRes = await axios.get(`${BASE_URL}/execution/${execId}/results`, {
    headers: { 'X-API-KEY': key },
    timeout: 120_000,
  });
  if (resultRes.data?.code !== 200 || !resultRes.data?.data) {
    throw new Error(`Fetch results failed: ${resultRes.data?.message}`);
  }

  const { columns, data: rows } = resultRes.data.data as {
    columns: { name: string }[];
    data: unknown[][];
  };
  const result = (rows ?? []).map(row =>
    Object.fromEntries(columns.map((c, i) => [c.name, (row as unknown[])[i]])) as T
  );
  logger.debug(`  ← ${result.length} rows`);
  return result;
}

// ── Public: execute SQL and return typed rows ─────────────────────────────────
export async function executeQueryAndWait<T = Record<string, unknown>>(sql: string, maxRetries = 3): Promise<T[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const key = await acquireKey();
    logger.debug(`SQL ▶ ${sql.slice(0, 120).replace(/\s+/g, ' ')}… (attempt ${attempt}/${maxRetries})`);
    try {
      const result = await executeOnce<T>(sql, key);
      releaseKey(key);
      return result;
    } catch (err) {
      lastErr = err;
      if (isRateLimited(err)) {
        penalizeKey(key); // 2 min penalty; next acquireKey() picks a different key
        if (attempt < maxRetries) {
          logger.warn(`  429 — rotating to next key (attempt ${attempt}/${maxRetries})`);
          continue;
        }
      } else {
        releaseKey(key);
        if (isRetryable(err) && attempt < maxRetries) {
          const wait = attempt * 3_000;
          logger.warn(`  Network error (attempt ${attempt}/${maxRetries}): ${(err as Error).message} — retrying in ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }
      }
      throw err;
    }
  }
  throw lastErr;
}

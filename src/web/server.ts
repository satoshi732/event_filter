import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';
import { logger } from '../utils/logger.js';
import {
  getAiAuditModelConfigs,
  getAiAuditBackendConfig,
  getAiAuditProviderConfigs,
  getChainConfigsSnapshot,
  getDefaultAiAuditModel,
  getDefaultAiAuditProvider,
  getMonitoredChains,
  getPatternSyncConfig,
  getPollIntervalMs,
  getConfigSnapshot,
  normalizeAiAuditModel,
  normalizeAiAuditProvider,
  reloadRuntimeConfig,
  getWebSecurityConfig,
} from '../config.js';
import { PipelineProgressUpdate, PipelineRunResult, runPipeline } from '../pipeline.js';
import {
  buildContractDetail,
  buildDashboardContracts,
  buildDashboardTokens,
  buildPersistedRun,
  latestRunMeta,
  latestPersistedRunMeta,
  tokenSummary,
  withLiveReviews,
  type DashboardContractSummary,
  type DashboardTokenSummary,
  type LatestRunMeta,
} from '../modules/dashboard/read-model.js';
import {
  getWhitelistPatterns,
  getTokenRegistry,
  getSingleContractAiAudit,
  getSingleTokenAiAudit,
  replaceWhitelistPatterns,
  replaceAiAuditModels,
  replaceAiAuditProviders,
  requestContractAiAudit,
  requestTokenAiAudit,
  saveTokenManualReview,
  saveContractAiAuditResult,
  saveTokenAiAuditResult,
  setManyAppSettings,
  upsertChainSettings,
} from '../db.js';
import {
  getPatternSyncStatus,
  pullPatterns,
  pushPatterns,
  queueSeenContractReviewTarget,
  saveContractReview,
  subscribePatternSyncEvents,
  startAutoPatternSyncLoop,
  verifyPatterns,
} from '../modules/selectors-manager/index.js';
import {
  enqueueContractAiAudit,
  enqueueTokenAiAudit,
  getContractAiAuditPlan,
  subscribeAiAuditEvents,
  startAiAuditWorker,
} from '../modules/ai-audit-runner/index.js';
import {
  configureAutoAnalysisEngine,
  getAutoAnalysisStatus,
  startAutoAnalysis,
  startAutoAnalysisEngine,
  stopAutoAnalysis,
  subscribeAutoAnalysisStatus,
} from '../modules/auto-analysis/index.js';
import { safeEqualString, verifyPassword } from '../utils/web-security.js';
import { getUserAuthConfig, USER_FILE_PATH } from '../utils/user-auth.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PUBLIC_DIR = path.join(ROOT, 'public');
const VIEWS_DIR = path.join(ROOT, 'views');

interface WebState {
  running: boolean;
  runningChain: string | null;
  progress: PipelineProgressUpdate | null;
  latestRuns: Map<string, PipelineRunResult>;
}

type StateStreamClient = ServerResponse<IncomingMessage> & {
  __stateHeartbeat?: NodeJS.Timeout;
};

interface WebSession {
  username: string;
  expiresAt: number;
}

const SESSION_COOKIE_NAME = 'solana_mev_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const pageRoutes = new Set(['/', '/token', '/token.html', '/token-detail', '/token-detail.html', '/contract', '/contract.html']);
const sessions = new Map<string, WebSession>();

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, statusCode: number, html: string): void {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
}

async function readTextFileSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function resolveReportFilePath(rawPath: string): string {
  const candidate = path.isAbsolute(rawPath) ? rawPath : path.join(ROOT, rawPath);
  return path.normalize(candidate);
}

function resolveProjectPath(rawPath: string): string {
  const candidate = path.isAbsolute(rawPath) ? rawPath : path.join(ROOT, rawPath);
  return path.normalize(candidate);
}

function sendAuthConfigurationError(res: ServerResponse): void {
  res.writeHead(503, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end('Authentication is enabled but not configured correctly');
}

function sanitizeRuntimeConfig(snapshot: ReturnType<typeof getConfigSnapshot>) {
  const access = snapshot.web_security ?? {};
  return {
    ...snapshot,
    web_security: {
      ...access,
    },
  };
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function compareNumberLike(a: number | null | undefined, b: number | null | undefined): number {
  return (Number(a) || 0) - (Number(b) || 0);
}

function compareStringLike(a: string | null | undefined, b: string | null | undefined): number {
  return String(a || '').localeCompare(String(b || ''));
}

function applyDashboardContractQuery(
  rows: DashboardContractSummary[],
  search: string,
  risk: string,
  link: string,
  sortKey: string,
  sortDir: string,
  page: number,
  pageSize: number,
) {
  const queryText = String(search || '').trim().toLowerCase();
  let filtered = rows.filter((row) => {
    const isSeen = Boolean(row.is_seen_pattern || row.group_kind === 'seen');
    const riskMatch = risk === 'all'
      || (risk === 'exploitable' && row.is_exploitable)
      || (risk === 'seen' && isSeen)
      || (risk === 'unseen' && !isSeen);
    const linkType = row.link_type || 'plain';
    const linkMatch = link === 'all' || link === linkType;
    const searchBlob = [
      row.contract,
      row.linkage,
      row.label,
      ...(row.patterns || []),
      ...(row.tokens || []).map((token) => `${token.token} ${token.token_symbol || ''} ${token.token_name || ''}`),
    ].join(' ').toLowerCase();
    const queryMatch = !queryText || searchBlob.includes(queryText);
    return riskMatch && linkMatch && queryMatch;
  });

  filtered = [...filtered].sort((a, b) => {
    let delta = 0;
    switch (sortKey) {
      case 'contract':
        delta = compareStringLike(a.contract, b.contract);
        break;
      case 'label':
        delta = compareStringLike(a.label, b.label);
        break;
      case 'linkage':
        delta = compareStringLike(a.linkage, b.linkage);
        break;
      case 'patterns':
        delta = compareStringLike((a.patterns || []).join(','), (b.patterns || []).join(','));
        break;
      case 'deployed':
        delta = compareStringLike(a.deployed_at, b.deployed_at);
        break;
      case 'auto_audit_status':
        delta = compareStringLike(a.auto_audit_status, b.auto_audit_status);
        break;
      case 'total_usd':
      default:
        delta = compareNumberLike(a.portfolio_usd, b.portfolio_usd);
        break;
    }
    if (delta === 0) {
      delta = compareStringLike(a.contract, b.contract);
    }
    return sortDir === 'asc' ? delta : -delta;
  });

  const totalRows = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const normalizedPage = Math.max(1, Math.min(page, totalPages));
  const start = (normalizedPage - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize),
    totalRows,
    page: normalizedPage,
    pageSize,
  };
}

function applyDashboardTokenQuery(
  rows: DashboardTokenSummary[],
  search: string,
  sortKey: string,
  sortDir: string,
  page: number,
  pageSize: number,
) {
  const queryText = String(search || '').trim().toLowerCase();
  let filtered = rows.filter((row) => {
    const searchBlob = `${row.token} ${row.token_name || ''} ${row.token_symbol || ''}`.toLowerCase();
    return !queryText || searchBlob.includes(queryText);
  });

  filtered = [...filtered].sort((a, b) => {
    let delta = 0;
    switch (sortKey) {
      case 'token':
        delta = compareStringLike(a.token, b.token);
        break;
      case 'name':
        delta = compareStringLike(a.token_name || a.token, b.token_name || b.token);
        break;
      case 'symbol':
        delta = compareStringLike(a.token_symbol, b.token_symbol);
        break;
      case 'sync':
        delta = compareStringLike(String(a.token_calls_sync), String(b.token_calls_sync));
        break;
      case 'auto_audit_status':
        delta = compareStringLike(a.auto_audit_status, b.auto_audit_status);
        break;
      case 'audit_result':
        delta = compareStringLike(
          `${a.auto_audit_critical ?? 0}:${a.auto_audit_high ?? 0}:${a.auto_audit_medium ?? 0}`,
          `${b.auto_audit_critical ?? 0}:${b.auto_audit_high ?? 0}:${b.auto_audit_medium ?? 0}`,
        );
        break;
      case 'manual_audit':
        delta = compareNumberLike(a.is_manual_audit ? 1 : 0, b.is_manual_audit ? 1 : 0);
        break;
      case 'price':
        delta = compareNumberLike(a.token_price_usd, b.token_price_usd);
        break;
      case 'contracts':
      default:
        delta = compareNumberLike(a.related_contract_count, b.related_contract_count);
        break;
    }
    if (delta === 0) {
      delta = compareStringLike(a.token, b.token);
    }
    return sortDir === 'asc' ? delta : -delta;
  });

  const totalRows = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const normalizedPage = Math.max(1, Math.min(page, totalPages));
  const start = (normalizedPage - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize),
    totalRows,
    page: normalizedPage,
    pageSize,
  };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const raw = String(header || '').trim();
  if (!raw) return result;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.split('=');
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) continue;
    result[normalizedKey] = decodeURIComponent(rest.join('=').trim());
  }
  return result;
}

function createSessionToken(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

function getAuthenticatedSession(req: IncomingMessage): { token: string; session: WebSession } | null {
  purgeExpiredSessions();
  const cookies = parseCookies(req.headers.cookie);
  const token = String(cookies[SESSION_COOKIE_NAME] || '').trim();
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, session };
}

function setSessionCookie(res: ServerResponse, token: string, secure: boolean): void {
  const cookie = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
}

function clearSessionCookie(res: ServerResponse, secure: boolean): void {
  const cookie = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
}

async function buildSettingsPayload() {
  const snapshot = getConfigSnapshot();
  const chainConfigs = getChainConfigsSnapshot();
  const security = getWebSecurityConfig();
  const userAuth = getUserAuthConfig();

  return {
    runtime_settings: {
      chainbase_keys: snapshot.chainbase_keys ?? [],
      rpc_keys: snapshot.rpc_keys ?? [],
      monitored_chains: getMonitoredChains(),
      poll_interval_ms: getPollIntervalMs(),
      debug: Boolean(snapshot.debug),
      pattern_sync: snapshot.pattern_sync ?? null,
      pancakeswap_price: snapshot.pancakeswap_price ?? { max_req_per_second: 2, max_req_per_minute: 90 },
      ai_audit_backend: snapshot.ai_audit_backend ?? getAiAuditBackendConfig(),
      auto_analysis: snapshot.auto_analysis ?? null,
      access: {
        auth_enabled: userAuth.authEnabled,
        username: userAuth.username,
        password: '',
        has_password: Boolean(userAuth.passwordHash),
        auth_source: path.relative(ROOT, USER_FILE_PATH),
        https_enabled: security.httpsEnabled,
        tls_cert_path: security.tlsCertPath,
        tls_key_path: security.tlsKeyPath,
      },
    },
    chain_configs: Object.entries(chainConfigs).map(([chain, cfg]) => ({
      chain,
      name: cfg.name,
      chain_id: cfg.chainId,
      table_prefix: cfg.tablePrefix,
      blocks_per_scan: cfg.blocksPerScan,
      chainbase_keys: cfg.chainbaseKeys,
      rpc_urls: cfg.rpcUrls,
      multicall3: cfg.multicall3Address,
      native_currency: cfg.nativeCurrency,
    })),
    ai_providers: getAiAuditProviderConfigs(),
    ai_models: getAiAuditModelConfigs(),
    whitelist_patterns: getWhitelistPatterns(),
    runtime_config: sanitizeRuntimeConfig(snapshot),
    hot_applied: true,
  };
}

function buildAiAuditConfigPayload() {
  return {
    ai_providers: getAiAuditProviderConfigs(),
    ai_models: getAiAuditModelConfigs(),
    default_provider: getDefaultAiAuditProvider(),
    default_model: getDefaultAiAuditModel(getDefaultAiAuditProvider()),
  };
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
  }
  if (typeof value === 'string') {
    return [...new Set(
      value
        .split(/\r?\n|,/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    )];
  }
  return [];
}

function coercePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function coerceBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeAiModelRows(
  providers: Array<{ provider: string; enabled: boolean; position: number }>,
  models: Array<{ provider: string; model: string; enabled: boolean; isDefault: boolean; position: number }>,
): Array<{ provider: string; model: string; enabled: boolean; isDefault: boolean; position: number }> {
  const activeProviders = new Set(providers.map((row) => row.provider.trim().toLowerCase()).filter(Boolean));
  const filtered = models
    .map((row) => ({
      provider: row.provider.trim().toLowerCase(),
      model: row.model.trim(),
      enabled: row.enabled,
      isDefault: row.isDefault,
      position: row.position,
    }))
    .filter((row) => row.provider && row.model && activeProviders.has(row.provider));

  const byProvider = new Map<string, typeof filtered>();
  for (const row of filtered) {
    const bucket = byProvider.get(row.provider) ?? [];
    bucket.push(row);
    byProvider.set(row.provider, bucket);
  }

  for (const rows of byProvider.values()) {
    rows.sort((a, b) => a.position - b.position || a.model.localeCompare(b.model));
    if (!rows.some((row) => row.isDefault)) {
      if (rows[0]) rows[0].isDefault = true;
      continue;
    }
    let seenDefault = false;
    for (const row of rows) {
      if (row.isDefault && !seenDefault) {
        seenDefault = true;
      } else if (row.isDefault) {
        row.isDefault = false;
      }
    }
  }

  return filtered;
}

async function serveStatic(reqPath: string, res: ServerResponse): Promise<void> {
  const candidate = reqPath === '/'
    ? path.join(PUBLIC_DIR, 'index.html')
    : path.join(PUBLIC_DIR, reqPath.replace(/^\/+/, ''));
  const filePath = path.normalize(candidate);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.js' ? 'text/javascript; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(file);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

async function renderPage(res: ServerResponse, viewPath: string, data: Record<string, unknown>): Promise<void> {
  try {
    const html = await ejs.renderFile(path.join(VIEWS_DIR, viewPath), data, { async: true });
    sendHtml(res, 200, html);
  } catch (err) {
    logger.error('Template render failed', err);
    sendJson(res, 500, { error: 'Template render failed' });
  }
}

function isStaticAssetRequest(reqPath: string): boolean {
  if (!reqPath || reqPath === '/') return false;
  const ext = path.extname(reqPath).toLowerCase();
  return ['.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.map'].includes(ext);
}

export async function startWebServer(
  chains: string[],
  host: string,
  port: number,
): Promise<void> {
  startAutoPatternSyncLoop();
  startAiAuditWorker();

  const state: WebState = {
    running: false,
    runningChain: null,
    progress: null,
    latestRuns: new Map(),
  };
  const stateStreamClients = new Set<StateStreamClient>();
  const persistedRunCache = new Map<string, PipelineRunResult | null>();
  const dashboardContractsCache = new Map<string, { runKey: string; rows: DashboardContractSummary[] }>();
  const dashboardTokensCache = new Map<string, { runKey: string; rows: DashboardTokenSummary[] }>();
  const contractDetailCache = new Map<string, { runKey: string; detail: ReturnType<typeof buildContractDetail> }>();

  function runCacheKey(run: PipelineRunResult): string {
    return `${run.chain}:${run.generated_at}:${run.block_from}:${run.block_to}:${run.token_count}`;
  }

  function invalidateReadCaches(chain?: string): void {
    if (!chain) {
      persistedRunCache.clear();
      dashboardContractsCache.clear();
      dashboardTokensCache.clear();
      contractDetailCache.clear();
      return;
    }
    const normalizedChain = chain.toLowerCase();
    persistedRunCache.delete(normalizedChain);
    dashboardContractsCache.delete(normalizedChain);
    dashboardTokensCache.delete(normalizedChain);
    for (const key of [...contractDetailCache.keys()]) {
      if (key.startsWith(`${normalizedChain}:`)) contractDetailCache.delete(key);
    }
  }

  function resolveRun(chain: string): PipelineRunResult | null {
    const normalizedChain = chain.toLowerCase();
    const inMemory = state.latestRuns.get(normalizedChain);
    if (inMemory) return inMemory;
    if (persistedRunCache.has(normalizedChain)) {
      return persistedRunCache.get(normalizedChain) ?? null;
    }
    const persisted = buildPersistedRun(normalizedChain) ?? null;
    persistedRunCache.set(normalizedChain, persisted);
    return persisted;
  }

  function resolveDashboardContracts(chain: string, run: PipelineRunResult): DashboardContractSummary[] {
    const normalizedChain = chain.toLowerCase();
    const key = runCacheKey(run);
    const cached = dashboardContractsCache.get(normalizedChain);
    if (cached?.runKey === key) return cached.rows;
    const rows = buildDashboardContracts(normalizedChain, run);
    dashboardContractsCache.set(normalizedChain, { runKey: key, rows });
    return rows;
  }

  function resolveDashboardTokens(chain: string, run: PipelineRunResult): DashboardTokenSummary[] {
    const normalizedChain = chain.toLowerCase();
    const key = runCacheKey(run);
    const cached = dashboardTokensCache.get(normalizedChain);
    if (cached?.runKey === key) return cached.rows;
    const rows = buildDashboardTokens(normalizedChain, run);
    dashboardTokensCache.set(normalizedChain, { runKey: key, rows });
    return rows;
  }

  function resolveContractDetail(chain: string, run: PipelineRunResult, contract: string) {
    const normalizedChain = chain.toLowerCase();
    const normalizedContract = contract.toLowerCase();
    const key = `${normalizedChain}:${normalizedContract}`;
    const runKey = runCacheKey(run);
    const cached = contractDetailCache.get(key);
    if (cached?.runKey === runKey) return cached.detail;
    const detail = buildContractDetail(normalizedChain, run, normalizedContract);
    contractDetailCache.set(key, { runKey, detail });
    return detail;
  }

  async function buildStatePayload() {
    const syncStatus = await getPatternSyncStatus();
    const latestRuns = chains.flatMap((chain) => {
      const inMemory = state.latestRuns.get(chain);
      if (inMemory) return [latestRunMeta(inMemory)];
      const persisted = latestPersistedRunMeta(chain);
      return persisted ? [persisted] : [];
    }).sort((left, right) =>
      String(right.generated_at || '').localeCompare(String(left.generated_at || '')),
    );

    return {
      running: state.running,
      running_chain: state.runningChain,
      progress: state.progress,
      chains,
      default_chain: chains[0] ?? null,
      latest_runs: latestRuns,
      sync_status: syncStatus,
      auto_analysis: getAutoAnalysisStatus(),
    };
  }

  function writeSseEvent(client: ServerResponse, event: string, payload: unknown): void {
    client.write(`event: ${event}\n`);
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function broadcastNamedEvent(event: string, payload: unknown): void {
    if (!stateStreamClients.size) return;
    for (const client of stateStreamClients) {
      if (client.destroyed || client.writableEnded) {
        stateStreamClients.delete(client);
        continue;
      }
      writeSseEvent(client, event, payload);
    }
  }

  async function broadcastStateSnapshot(): Promise<void> {
    if (!stateStreamClients.size) return;
    const payload = await buildStatePayload();
    for (const client of stateStreamClients) {
      if (client.destroyed || client.writableEnded) {
        stateStreamClients.delete(client);
        continue;
      }
      writeSseEvent(client, 'state', payload);
    }
  }

  async function handleRun(chain: string): Promise<PipelineRunResult> {
    if (state.running) {
      throw new Error(`Scan already running for ${state.runningChain ?? 'unknown chain'}`);
    }

    state.running = true;
    state.runningChain = chain;
    state.progress = {
      chain,
      stage: 'boot',
      label: 'Queued pipeline run',
      percent: 0,
      updated_at: new Date().toISOString(),
    };
    broadcastNamedEvent('data-refresh', {
      kind: 'run-started',
      chain,
      ts: new Date().toISOString(),
    });
    await broadcastStateSnapshot();

    try {
      const run = await runPipeline(chain, {
        onProgress: (update) => {
          state.progress = update;
          void broadcastStateSnapshot();
        },
      });
      state.latestRuns.set(chain, run);
      invalidateReadCaches(chain);
      state.progress = {
        chain,
        stage: 'complete',
        label: 'Round complete',
        percent: 100,
        current: run.token_count,
        total: run.token_count,
        detail: `blocks ${run.block_from} -> ${run.block_to}`,
        updated_at: new Date().toISOString(),
      };
      broadcastNamedEvent('data-refresh', {
        kind: 'run-completed',
        chain,
        run: latestRunMeta(run),
        ts: new Date().toISOString(),
      });
      await broadcastStateSnapshot();
      return run;
    } catch (err) {
      state.progress = {
        chain,
        stage: 'failed',
        label: 'Pipeline run failed',
        percent: state.progress?.percent ?? 0,
        detail: (err as Error).message || 'Unknown error',
        updated_at: new Date().toISOString(),
      };
      broadcastNamedEvent('data-refresh', {
        kind: 'run-failed',
        chain,
        error: (err as Error).message || 'Unknown error',
        ts: new Date().toISOString(),
      });
      await broadcastStateSnapshot();
      throw err;
    } finally {
      state.running = false;
      state.runningChain = null;
      await broadcastStateSnapshot();
    }
  }

  configureAutoAnalysisEngine({
    runRound: handleRun,
    isRoundRunning: () => state.running,
  });
  const unsubscribeAutoAnalysis = subscribeAutoAnalysisStatus((status) => {
    broadcastNamedEvent('auto-analysis', status);
  });
  const unsubscribeAiAudit = subscribeAiAuditEvents((event) => {
    invalidateReadCaches(event.chain);
    broadcastNamedEvent('ai-audit', event);
  });
  const unsubscribePatternSync = subscribePatternSyncEvents((event) => {
    broadcastNamedEvent('pattern-sync', event);
  });
  startAutoAnalysisEngine();

  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method ?? 'GET';
      const security = getWebSecurityConfig();
      const userAuth = getUserAuthConfig();
      const requestProtocol = security.httpsEnabled ? 'https' : 'http';
      const url = new URL(req.url ?? '/', `${requestProtocol}://localhost`);
      const reqPath = url.pathname;
      const activeSession = getAuthenticatedSession(req);
      const isApiRequest = reqPath.startsWith('/api/');
      const isPageRequest = method === 'GET' && pageRoutes.has(reqPath);
      const isPublicRequest = (method === 'GET' && reqPath === '/login')
        || (method === 'POST' && reqPath === '/api/login')
        || (method === 'POST' && reqPath === '/api/logout')
        || (method === 'GET' && isStaticAssetRequest(reqPath));

      if (userAuth.authEnabled) {
        if (!userAuth.username || !userAuth.passwordHash) {
          sendAuthConfigurationError(res);
          return;
        }
        if (!isPublicRequest && !activeSession) {
          if (isApiRequest) {
            sendJson(res, 401, { error: 'Authentication required', auth_required: true });
            return;
          }
          if (isPageRequest || method === 'GET') {
            const nextValue = req.url && req.url !== '/login' ? req.url : '/';
            res.writeHead(302, {
              Location: `/login?next=${encodeURIComponent(nextValue || '/')}`,
              'Cache-Control': 'no-store',
            });
            res.end();
            return;
          }
        }
      }

      if (method === 'GET' && reqPath === '/login') {
        if (!userAuth.authEnabled) {
          res.writeHead(302, { Location: String(url.searchParams.get('next') || '/'), 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        if (activeSession) {
          res.writeHead(302, { Location: String(url.searchParams.get('next') || '/'), 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        await renderPage(res, 'pages/login.ejs', {
          title: 'Sign In',
          next: String(url.searchParams.get('next') || '/'),
        });
        return;
      }

      if (method === 'POST' && reqPath === '/api/login') {
        if (!userAuth.authEnabled) {
          sendJson(res, 200, { ok: true, next: '/' });
          return;
        }
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const nextPath = String(body.next || '/').trim() || '/';
        const authenticated = safeEqualString(username, userAuth.username) && verifyPassword(password, userAuth.passwordHash);
        if (!authenticated) {
          sendJson(res, 401, { error: 'Invalid username or password' });
          return;
        }
        const token = createSessionToken();
        sessions.set(token, {
          username,
          expiresAt: Date.now() + SESSION_TTL_MS,
        });
        setSessionCookie(res, token, security.httpsEnabled);
        sendJson(res, 200, { ok: true, next: nextPath });
        return;
      }

      if (method === 'POST' && reqPath === '/api/logout') {
        if (activeSession) {
          sessions.delete(activeSession.token);
        }
        clearSessionCookie(res, security.httpsEnabled);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && reqPath === '/') {
        await renderPage(res, 'pages/dashboard.ejs', {
          title: 'Solana Mev Labs',
          initialView: 'dashboard',
          authEnabled: userAuth.authEnabled,
          currentUser: activeSession?.session.username || '',
        });
        return;
      }

      if (method === 'GET' && (reqPath === '/token' || reqPath === '/token.html')) {
        await renderPage(res, 'pages/dashboard.ejs', {
          title: 'Token Directory',
          initialView: 'token',
          authEnabled: userAuth.authEnabled,
          currentUser: activeSession?.session.username || '',
        });
        return;
      }

      if (method === 'GET' && (reqPath === '/token-detail' || reqPath === '/token-detail.html')) {
        await renderPage(res, 'pages/dashboard.ejs', {
          title: 'Token Detail',
          initialView: 'token-detail',
          authEnabled: userAuth.authEnabled,
          currentUser: activeSession?.session.username || '',
        });
        return;
      }

      if (method === 'GET' && (reqPath === '/contract' || reqPath === '/contract.html')) {
        await renderPage(res, 'pages/dashboard.ejs', {
          title: 'Contract Detail',
          initialView: 'contract',
          authEnabled: userAuth.authEnabled,
          currentUser: activeSession?.session.username || '',
        });
        return;
      }

      if (reqPath === '/api/state' && method === 'GET') {
        sendJson(res, 200, await buildStatePayload());
        return;
      }

      if (reqPath === '/api/auto-analysis' && method === 'GET') {
        sendJson(res, 200, getAutoAnalysisStatus());
        return;
      }

      if (reqPath === '/api/auto-analysis/start' && method === 'POST') {
        const body = await readJsonBody(req);
        const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
        if (!chain || !chains.includes(chain)) {
          sendJson(res, 400, { error: 'Unknown chain' });
          return;
        }

        const status = startAutoAnalysis(chain);
        await broadcastStateSnapshot();
        sendJson(res, 200, { ok: true, status });
        return;
      }

      if (reqPath === '/api/auto-analysis/stop' && method === 'POST') {
        const status = stopAutoAnalysis();
        await broadcastStateSnapshot();
        sendJson(res, 200, { ok: true, status });
        return;
      }

      if (reqPath === '/api/state/stream' && method === 'GET') {
        const client = res as StateStreamClient;
        client.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        client.write(': connected\n\n');
        stateStreamClients.add(client);
        writeSseEvent(client, 'state', await buildStatePayload());

        client.__stateHeartbeat = setInterval(() => {
          if (client.destroyed || client.writableEnded) return;
          client.write(': ping\n\n');
        }, 15_000);

        const cleanup = () => {
          stateStreamClients.delete(client);
          if (client.__stateHeartbeat) {
            clearInterval(client.__stateHeartbeat);
            client.__stateHeartbeat = undefined;
          }
        };

        req.on('close', cleanup);
        req.on('end', cleanup);
        return;
      }

      if (reqPath === '/api/dashboard' && method === 'GET') {
        const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
        const run = resolveRun(chain);
        if (!run) {
          sendJson(res, 404, { error: 'No results for this chain yet' });
          return;
        }

        sendJson(res, 200, {
          run: latestRunMeta(run),
          tokens: resolveDashboardTokens(chain, run),
          contracts: resolveDashboardContracts(chain, run),
        });
        return;
      }

      if (reqPath === '/api/contracts' && method === 'GET') {
        const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
        const run = resolveRun(chain);
        if (!run) {
          sendJson(res, 404, { error: 'No results for this chain yet' });
          return;
        }
        const search = url.searchParams.get('q') ?? '';
        const risk = (url.searchParams.get('risk') ?? 'all').toLowerCase();
        const link = (url.searchParams.get('link') ?? 'all').toLowerCase();
        const sortKey = String(url.searchParams.get('sort_key') ?? 'total_usd');
        const sortDir = String(url.searchParams.get('sort_dir') ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
        const page = parsePositiveInt(url.searchParams.get('page'), 1);
        const pageSize = parsePositiveInt(url.searchParams.get('page_size'), 40);
        const result = applyDashboardContractQuery(
          resolveDashboardContracts(chain, run),
          search,
          risk,
          link,
          sortKey,
          sortDir,
          page,
          pageSize,
        );

        sendJson(res, 200, {
          run: latestRunMeta(run),
          contracts: result.rows,
          total_rows: result.totalRows,
          page: result.page,
          page_size: result.pageSize,
        });
        return;
      }

      if (reqPath === '/api/tokens' && method === 'GET') {
        const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
        const run = resolveRun(chain);
        if (!run) {
          sendJson(res, 404, { error: 'No results for this chain yet' });
          return;
        }
        const search = url.searchParams.get('q') ?? '';
        const sortKey = String(url.searchParams.get('sort_key') ?? 'contracts');
        const sortDir = String(url.searchParams.get('sort_dir') ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
        const page = parsePositiveInt(url.searchParams.get('page'), 1);
        const pageSize = parsePositiveInt(url.searchParams.get('page_size'), 40);
        const result = applyDashboardTokenQuery(
          resolveDashboardTokens(chain, run),
          search,
          sortKey,
          sortDir,
          page,
          pageSize,
        );

        sendJson(res, 200, {
          run: latestRunMeta(run),
          tokens: result.rows,
          total_rows: result.totalRows,
          page: result.page,
          page_size: result.pageSize,
        });
        return;
      }

      if (reqPath === '/api/sync/status' && method === 'GET') {
        const syncStatus = await getPatternSyncStatus();
        sendJson(res, 200, syncStatus);
        return;
      }

      if (reqPath === '/api/sync/pull' && method === 'POST') {
        const result = await pullPatterns();
        invalidateReadCaches();
        sendJson(res, 200, {
          ok: true,
          result,
          status: await getPatternSyncStatus(),
        });
        return;
      }

      if (reqPath === '/api/sync/push' && method === 'POST') {
        const result = await pushPatterns();
        invalidateReadCaches();
        sendJson(res, 200, {
          ok: true,
          result,
          status: await getPatternSyncStatus(),
        });
        return;
      }

      if (reqPath === '/api/sync/verify' && method === 'POST') {
        const result = await verifyPatterns();
        sendJson(res, 200, {
          ok: true,
          result,
          status: await getPatternSyncStatus(),
        });
        return;
      }

      if (reqPath === '/api/seen-contract' && method === 'POST') {
        const body = await readJsonBody(req);
        const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
        const address = typeof body.address === 'string' ? body.address.toLowerCase() : '';
        const targetKind = typeof body.target_kind === 'string' ? body.target_kind.toLowerCase() : 'auto';
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        if (!chain || !address || !label) {
          sendJson(res, 400, { error: 'chain, address, and label are required' });
          return;
        }

        const hash = queueSeenContractReviewTarget(chain, address, label, targetKind);
        const status = await getPatternSyncStatus();
        sendJson(res, 200, {
          ok: true,
          hash,
          status,
        });
        broadcastNamedEvent('review-updated', {
          kind: 'queued-contract-review',
          chain,
          targetType: 'contract',
          targetAddr: address,
          targetKind,
          hash,
          ts: new Date().toISOString(),
        });
        broadcastNamedEvent('pattern-sync', {
          kind: 'review-queue',
          result: { hash, targetKind, action: 'queue' },
          status,
          ts: new Date().toISOString(),
        });
        return;
      }

      if (reqPath === '/api/review' && method === 'POST') {
        const body = await readJsonBody(req);
        const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
        const address = typeof body.address === 'string' ? body.address.toLowerCase() : '';
        const targetKind = typeof body.target_kind === 'string' ? body.target_kind.toLowerCase() : 'auto';
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        const reviewText = typeof body.review_text === 'string' ? body.review_text.trim() : '';
        const exploitable = Boolean(body.exploitable);
        if (!chain || !address || !label) {
          sendJson(res, 400, { error: 'chain, address, and label are required' });
          return;
        }

        const result = saveContractReview({
          chain,
          address,
          targetKind,
          label,
          reviewText,
          exploitable,
        });
        invalidateReadCaches(chain);
        const status = await getPatternSyncStatus();
        sendJson(res, 200, {
          ok: true,
          hash: result.hash,
          persisted_only: result.persistedOnly,
          status,
        });
        broadcastNamedEvent('review-updated', {
          kind: 'saved-contract-review',
          chain,
          targetType: 'contract',
          targetAddr: address,
          targetKind,
          label,
          exploitable,
          hash: result.hash,
          persistedOnly: result.persistedOnly,
          ts: new Date().toISOString(),
        });
        broadcastNamedEvent('pattern-sync', {
          kind: 'review-save',
          result: { hash: result.hash, targetKind, action: 'save', persistedOnly: result.persistedOnly },
          status,
          ts: new Date().toISOString(),
        });
        return;
      }

      if (reqPath === '/api/contract-analysis/request' && method === 'POST') {
        const body = await readJsonBody(req);
        const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
        const contract = typeof body.contract === 'string' ? body.contract.toLowerCase() : '';
        if (!chain || !contract) {
          sendJson(res, 400, { error: 'chain and contract are required' });
          return;
        }

        const title = typeof body.title === 'string' ? body.title.trim() : 'AI Auto Audit';
        const provider = normalizeAiAuditProvider(
          typeof body.provider === 'string' ? body.provider.trim() : getDefaultAiAuditProvider(),
        );
        const model = normalizeAiAuditModel(
          provider,
          typeof body.model === 'string' ? body.model.trim() : getDefaultAiAuditModel(provider),
        );
        const plan = getContractAiAuditPlan(chain, contract);
        if (!plan.accepted) {
          sendJson(res, 400, { error: plan.reason || 'Contract is not eligible for AI audit' });
          return;
        }
        const analysis = requestContractAiAudit({ chain, contractAddr: contract, title, provider, model });
        enqueueContractAiAudit(analysis);
        invalidateReadCaches(chain);
        sendJson(res, 200, {
          ok: true,
          analysis,
          plan,
        });
        return;
      }

      if (reqPath === '/api/token-analysis/request' && method === 'POST') {
        const body = await readJsonBody(req);
        const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
        const token = typeof body.token === 'string' ? body.token.toLowerCase() : '';
        if (!chain || !token) {
          sendJson(res, 400, { error: 'chain and token are required' });
          return;
        }

        const title = typeof body.title === 'string' ? body.title.trim() : 'AI Auto Audit';
        const provider = normalizeAiAuditProvider(
          typeof body.provider === 'string' ? body.provider.trim() : getDefaultAiAuditProvider(),
        );
        const model = normalizeAiAuditModel(
          provider,
          typeof body.model === 'string' ? body.model.trim() : getDefaultAiAuditModel(provider),
        );
        const analysis = requestTokenAiAudit({ chain, tokenAddr: token, title, provider, model });
        enqueueTokenAiAudit(analysis);
        invalidateReadCaches(chain);
        sendJson(res, 200, {
          ok: true,
          analysis,
        });
        return;
      }

      if (reqPath === '/api/contract-analysis/result' && method === 'POST') {
        const body = await readJsonBody(req);
        const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
        const contract = typeof body.contract === 'string' ? body.contract.toLowerCase() : '';
        if (!chain || !contract) {
          sendJson(res, 400, { error: 'chain and contract are required' });
          return;
        }

        const analysis = saveContractAiAuditResult({
          chain,
          contractAddr: contract,
          requestSession: typeof body.request_session === 'string' ? body.request_session : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          provider: typeof body.provider === 'string' ? body.provider : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          critical: typeof body.critical === 'number' ? body.critical : null,
          high: typeof body.high === 'number' ? body.high : null,
          medium: typeof body.medium === 'number' ? body.medium : null,
          resultPath: typeof body.result_path === 'string' ? body.result_path : null,
          isSuccess: body.isSuccess == null ? null : Boolean(body.isSuccess),
          auditedAt: typeof body.audited_at === 'string' ? body.audited_at : null,
        });
        invalidateReadCaches(chain);

        sendJson(res, 200, {
          ok: true,
          analysis,
        });
        broadcastNamedEvent('ai-audit', {
          kind: analysis.auditedAt ? (analysis.isSuccess === false ? 'failed' : 'completed') : 'queued',
          chain,
          targetType: 'contract',
          targetAddr: contract,
          requestSession: analysis.requestSession,
          title: analysis.title,
          provider: analysis.provider,
          model: analysis.model,
          status: analysis.auditedAt
            ? (analysis.isSuccess === false ? 'failed' : 'completed')
            : 'requested',
          reportPath: analysis.resultPath,
          critical: analysis.critical,
          high: analysis.high,
          medium: analysis.medium,
          error: analysis.isSuccess === false ? 'audit failed' : null,
          ts: new Date().toISOString(),
        });
        return;
      }

      if (reqPath === '/api/token-analysis/result' && method === 'POST') {
        const body = await readJsonBody(req);
        const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
        const token = typeof body.token === 'string' ? body.token.toLowerCase() : '';
        if (!chain || !token) {
          sendJson(res, 400, { error: 'chain and token are required' });
          return;
        }

        const analysis = saveTokenAiAuditResult({
          chain,
          tokenAddr: token,
          requestSession: typeof body.request_session === 'string' ? body.request_session : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          provider: typeof body.provider === 'string' ? body.provider : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          critical: typeof body.critical === 'number' ? body.critical : null,
          high: typeof body.high === 'number' ? body.high : null,
          medium: typeof body.medium === 'number' ? body.medium : null,
          resultPath: typeof body.result_path === 'string' ? body.result_path : null,
          isSuccess: body.isSuccess == null ? null : Boolean(body.isSuccess),
          auditedAt: typeof body.audited_at === 'string' ? body.audited_at : null,
        });
        invalidateReadCaches(chain);

        sendJson(res, 200, {
          ok: true,
          analysis,
        });
        broadcastNamedEvent('ai-audit', {
          kind: analysis.auditedAt ? (analysis.isSuccess === false ? 'failed' : 'completed') : 'queued',
          chain,
          targetType: 'token',
          targetAddr: token,
          requestSession: analysis.requestSession,
          title: analysis.title,
          provider: analysis.provider,
          model: analysis.model,
          status: analysis.auditedAt
            ? (analysis.isSuccess === false ? 'failed' : 'completed')
            : 'requested',
          reportPath: analysis.resultPath,
          critical: analysis.critical,
          high: analysis.high,
          medium: analysis.medium,
          error: analysis.isSuccess === false ? 'audit failed' : null,
          ts: new Date().toISOString(),
        });
        return;
      }

      if (reqPath === '/api/contract-analysis/report' && method === 'GET') {
        const chain = (url.searchParams.get('chain') ?? '').toLowerCase();
        const contract = (url.searchParams.get('contract') ?? '').toLowerCase();
        if (!chain || !contract) {
          sendJson(res, 400, { error: 'chain and contract are required' });
          return;
        }

        const analysis = getSingleContractAiAudit(chain, contract);
        const reportPath = analysis?.resultPath;
        if (!reportPath) {
          sendJson(res, 404, { error: 'No AI report available for this contract' });
          return;
        }

        const filePath = resolveReportFilePath(reportPath);
        const reportText = await readTextFileSafe(filePath);
        if (!reportText) {
          sendJson(res, 404, { error: 'AI report file could not be read' });
          return;
        }

        sendHtml(res, 200, `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AI Analysis Report</title>
    <style>
      body { font-family: Georgia, serif; margin: 0; background: #f7f1e4; color: #2b2318; }
      main { max-width: 1100px; margin: 0 auto; padding: 24px; }
      .meta { margin-bottom: 16px; padding: 16px; border: 1px solid #d8c7a7; border-radius: 12px; background: #fffaf0; }
      pre { white-space: pre-wrap; word-break: break-word; padding: 20px; border-radius: 12px; border: 1px solid #d8c7a7; background: #fff; overflow: auto; }
      code { font-family: "IBM Plex Mono", monospace; font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <section class="meta">
        <strong>Contract</strong> ${escapeHtml(contract)}<br>
        <strong>Chain</strong> ${escapeHtml(chain)}<br>
        <strong>Report Path</strong> ${escapeHtml(reportPath)}
      </section>
      <pre><code>${escapeHtml(reportText)}</code></pre>
    </main>
  </body>
</html>`);
        return;
      }

      if (reqPath === '/api/token-analysis/report' && method === 'GET') {
        const chain = (url.searchParams.get('chain') ?? '').toLowerCase();
        const token = (url.searchParams.get('token') ?? '').toLowerCase();
        if (!chain || !token) {
          sendJson(res, 400, { error: 'chain and token are required' });
          return;
        }

        const analysis = getSingleTokenAiAudit(chain, token);
        const reportPath = analysis?.resultPath;
        if (!reportPath) {
          sendJson(res, 404, { error: 'No AI report available for this token' });
          return;
        }

        const filePath = resolveReportFilePath(reportPath);
        const reportText = await readTextFileSafe(filePath);
        if (!reportText) {
          sendJson(res, 404, { error: 'AI report file could not be read' });
          return;
        }

        sendHtml(res, 200, `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Token AI Analysis Report</title>
    <style>
      body { font-family: Georgia, serif; margin: 0; background: #f7f1e4; color: #2b2318; }
      main { max-width: 1100px; margin: 0 auto; padding: 24px; }
      .meta { margin-bottom: 16px; padding: 16px; border: 1px solid #d8c7a7; border-radius: 12px; background: #fffaf0; }
      pre { white-space: pre-wrap; word-break: break-word; padding: 20px; border-radius: 12px; border: 1px solid #d8c7a7; background: #fff; overflow: auto; }
      code { font-family: "IBM Plex Mono", monospace; font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <section class="meta">
        <strong>Token</strong> ${escapeHtml(token)}<br>
        <strong>Chain</strong> ${escapeHtml(chain)}<br>
        <strong>Report Path</strong> ${escapeHtml(reportPath)}
      </section>
      <pre><code>${escapeHtml(reportText)}</code></pre>
    </main>
  </body>
</html>`);
        return;
      }

      if (reqPath === '/api/run' && method === 'POST') {
        const body = await readJsonBody(req);
        const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : chains[0];
        if (!chain || !chains.includes(chain)) {
          sendJson(res, 400, { error: 'Invalid chain' });
          return;
        }

        if (state.running) {
          sendJson(res, 409, {
            error: 'Scan already running',
            running_chain: state.runningChain,
          });
          return;
        }

        const run = await handleRun(chain);
        sendJson(res, 200, {
          ok: true,
          run: latestRunMeta(run),
        });
        return;
      }

      if (reqPath === '/api/results' && method === 'GET') {
        const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
        const run = resolveRun(chain);
        if (!run) {
          sendJson(res, 404, { error: 'No results for this chain yet' });
          return;
        }

        sendJson(res, 200, {
          ...latestRunMeta(run),
          tokens: resolveDashboardTokens(chain, run),
        });
        return;
      }

      if (reqPath === '/api/token' && method === 'GET') {
        const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
        const token = (url.searchParams.get('token') ?? '').toLowerCase();
        const run = resolveRun(chain);
        if (!run) {
          sendJson(res, 404, { error: 'No results for this chain yet' });
          return;
        }

        const tokenResult = run.tokens.find((entry) => entry.token === token);
        if (!tokenResult) {
          sendJson(res, 404, { error: 'Token not found in latest results' });
          return;
        }

        const analysis = getSingleTokenAiAudit(chain, token);
        const tokenRegistry = getTokenRegistry(chain, [token]).get(token);
        const tokenWithReviews = withLiveReviews(chain, tokenResult);

        sendJson(res, 200, {
          run: latestRunMeta(run),
          token: {
            ...tokenWithReviews,
            review: tokenRegistry?.review ?? tokenWithReviews.review ?? '',
            is_exploitable: tokenRegistry?.isExploitable ?? Boolean(tokenWithReviews.is_exploitable),
            auto_analysis: analysis ? {
              request_session: analysis.requestSession,
              title: analysis.title,
              provider: normalizeAiAuditProvider(analysis.provider),
              model: normalizeAiAuditModel(analysis.provider, analysis.model),
              status: analysis.auditedAt
                ? (analysis.isSuccess === false ? 'failed' : 'completed')
                : 'requested',
              requested_at: analysis.requestedAt,
              completed_at: analysis.auditedAt,
              critical: analysis.critical,
              high: analysis.high,
              medium: analysis.medium,
              report_path: analysis.resultPath,
              error: analysis.isSuccess === false ? 'audit failed' : null,
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
          },
          ai_config: buildAiAuditConfigPayload(),
        });
        return;
      }

      if (reqPath === '/api/token-review' && method === 'POST') {
        const body = await readJsonBody(req);
        const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
        const token = typeof body.token === 'string' ? body.token.toLowerCase() : '';
        const reviewText = typeof body.review_text === 'string' ? body.review_text.trim() : '';
        const exploitable = Boolean(body.exploitable);
        if (!chain || !token) {
          sendJson(res, 400, { error: 'chain and token are required' });
          return;
        }

        const saved = saveTokenManualReview({
          chain,
          token,
          reviewText,
          exploitable,
        });
        invalidateReadCaches(chain);
        sendJson(res, 200, {
          ok: true,
          token: saved,
        });
        broadcastNamedEvent('review-updated', {
          kind: 'saved-token-review',
          chain,
          targetType: 'token',
          targetAddr: token,
          exploitable,
          ts: new Date().toISOString(),
        });
        return;
      }

      if (reqPath === '/api/contract' && method === 'GET') {
        const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
        const contract = (url.searchParams.get('contract') ?? '').toLowerCase();
        const run = resolveRun(chain);
        if (!run) {
          sendJson(res, 404, { error: 'No results for this chain yet' });
          return;
        }
        if (!contract) {
          sendJson(res, 400, { error: 'contract is required' });
          return;
        }

        const detail = resolveContractDetail(chain, run, contract);
        if (!detail) {
          sendJson(res, 404, { error: 'Contract not found in latest results' });
          return;
        }

        sendJson(res, 200, {
          run: latestRunMeta(run),
          contract: detail,
          ai_config: buildAiAuditConfigPayload(),
        });
        return;
      }

      if (reqPath === '/api/settings' && method === 'GET') {
        sendJson(res, 200, await buildSettingsPayload());
        return;
      }

      if (reqPath === '/api/settings' && method === 'POST') {
        const body = await readJsonBody(req);
        const runtime = (typeof body.runtime_settings === 'object' && body.runtime_settings)
          ? body.runtime_settings as Record<string, unknown>
          : {};
        const patternSync = (typeof runtime.pattern_sync === 'object' && runtime.pattern_sync)
          ? runtime.pattern_sync as Record<string, unknown>
          : {};
        const pancakePrice = (typeof runtime.pancakeswap_price === 'object' && runtime.pancakeswap_price)
          ? runtime.pancakeswap_price as Record<string, unknown>
          : {};
        const aiAuditBackend = (typeof runtime.ai_audit_backend === 'object' && runtime.ai_audit_backend)
          ? runtime.ai_audit_backend as Record<string, unknown>
          : {};
        const autoAnalysis = (typeof runtime.auto_analysis === 'object' && runtime.auto_analysis)
          ? runtime.auto_analysis as Record<string, unknown>
          : {};
        const access = (typeof runtime.access === 'object' && runtime.access)
          ? runtime.access as Record<string, unknown>
          : {};

        const chainConfigs = Array.isArray(body.chain_configs)
          ? body.chain_configs as Array<Record<string, unknown>>
          : [];
        const aiProviders = Array.isArray(body.ai_providers)
          ? body.ai_providers as Array<Record<string, unknown>>
          : [];
        const aiModelsRaw = Array.isArray(body.ai_models)
          ? body.ai_models as Array<Record<string, unknown>>
          : [];
        const whitelistPatterns = Array.isArray(body.whitelist_patterns)
          ? body.whitelist_patterns as Array<Record<string, unknown>>
          : [];

        const normalizedProviders = aiProviders
          .map((row, index) => ({
            provider: String(row.provider || '').trim().toLowerCase(),
            enabled: coerceBoolean(row.enabled, true),
            position: coercePositiveInt(row.position, index),
          }))
          .filter((row) => row.provider);

        const normalizedModels = normalizeAiModelRows(
          normalizedProviders,
          aiModelsRaw.map((row, index) => ({
            provider: String(row.provider || '').trim().toLowerCase(),
            model: String(row.model || '').trim(),
            enabled: coerceBoolean(row.enabled, true),
            isDefault: coerceBoolean(row.is_default ?? row.isDefault, false),
            position: coercePositiveInt(row.position, index),
          })),
        );

        const httpsEnabled = coerceBoolean(access.https_enabled, false);
        const tlsCertPath = String(access.tls_cert_path || '').trim();
        const tlsKeyPath = String(access.tls_key_path || '').trim();

        if (httpsEnabled && (!tlsCertPath || !tlsKeyPath)) {
          sendJson(res, 400, { error: 'TLS cert path and key path are required when HTTPS is enabled' });
          return;
        }

        if (httpsEnabled) {
          try {
            await readFile(resolveProjectPath(tlsCertPath));
            await readFile(resolveProjectPath(tlsKeyPath));
          } catch (err) {
            sendJson(res, 400, { error: `TLS files could not be read: ${(err as Error).message}` });
            return;
          }
        }

        setManyAppSettings([
          { key: 'chainbase_keys', value: JSON.stringify(coerceStringArray(runtime.chainbase_keys)) },
          { key: 'rpc_keys', value: JSON.stringify(coerceStringArray(runtime.rpc_keys)) },
          { key: 'monitor_chains', value: JSON.stringify(coerceStringArray(runtime.monitored_chains)) },
          { key: 'poll_interval_ms', value: String(coercePositiveInt(runtime.poll_interval_ms, 600_000)) },
          { key: 'debug', value: coerceBoolean(runtime.debug, false) ? '1' : '0' },
          { key: 'pattern_sync.host', value: String(patternSync.host || '').trim() },
          { key: 'pattern_sync.port', value: String(coercePositiveInt(patternSync.port, 5432)) },
          { key: 'pattern_sync.database', value: String(patternSync.database || '').trim() },
          { key: 'pattern_sync.user', value: String(patternSync.user || '').trim() },
          { key: 'pattern_sync.password', value: String(patternSync.password || '').trim() },
          { key: 'pattern_sync.remote_name', value: String(patternSync.remote_name || 'default').trim() || 'default' },
          { key: 'pattern_sync.auto_pull', value: coerceBoolean(patternSync.auto_pull, true) ? '1' : '0' },
          { key: 'pattern_sync.ssl', value: coerceBoolean(patternSync.ssl, false) ? '1' : '0' },
          { key: 'pancakeswap_price.max_req_per_second', value: String(coercePositiveInt(pancakePrice.max_req_per_second, 2)) },
          { key: 'pancakeswap_price.max_req_per_minute', value: String(coercePositiveInt(pancakePrice.max_req_per_minute, 90)) },
          { key: 'ai_audit_backend.base_url', value: String(aiAuditBackend.base_url || 'https://127.0.0.1:5000').trim() },
          { key: 'ai_audit_backend.api_key', value: String(aiAuditBackend.api_key || '').trim() },
          { key: 'ai_audit_backend.etherscan_api_key', value: String(aiAuditBackend.etherscan_api_key || '').trim() },
          { key: 'ai_audit_backend.poll_interval_ms', value: String(coercePositiveInt(aiAuditBackend.poll_interval_ms, 10_000)) },
          { key: 'ai_audit_backend.dedaub_wait_seconds', value: String(coercePositiveInt(aiAuditBackend.dedaub_wait_seconds, 15)) },
          { key: 'ai_audit_backend.insecure_tls', value: coerceBoolean(aiAuditBackend.insecure_tls, true) ? '1' : '0' },
          { key: 'auto_analysis.queue_capacity', value: String(coercePositiveInt(autoAnalysis.queue_capacity, 10)) },
          { key: 'auto_analysis.token_share_percent', value: String(coercePositiveInt(autoAnalysis.token_share_percent, 40)) },
          { key: 'auto_analysis.contract_share_percent', value: String(coercePositiveInt(autoAnalysis.contract_share_percent, 60)) },
          { key: 'auto_analysis.contract_min_tvl_usd', value: String(Number.isFinite(Number(autoAnalysis.contract_min_tvl_usd)) ? Number(autoAnalysis.contract_min_tvl_usd) : 10000) },
          { key: 'auto_analysis.token_min_price_usd', value: String(Number.isFinite(Number(autoAnalysis.token_min_price_usd)) ? Number(autoAnalysis.token_min_price_usd) : 0.001) },
          { key: 'auto_analysis.require_token_sync', value: coerceBoolean(autoAnalysis.require_token_sync, true) ? '1' : '0' },
          { key: 'auto_analysis.require_contract_selectors', value: coerceBoolean(autoAnalysis.require_contract_selectors, true) ? '1' : '0' },
          { key: 'auto_analysis.skip_seen_contracts', value: coerceBoolean(autoAnalysis.skip_seen_contracts, true) ? '1' : '0' },
          { key: 'auto_analysis.one_per_contract_pattern', value: coerceBoolean(autoAnalysis.one_per_contract_pattern, true) ? '1' : '0' },
          { key: 'auto_analysis.exclude_audited_contracts', value: coerceBoolean(autoAnalysis.exclude_audited_contracts, true) ? '1' : '0' },
          { key: 'auto_analysis.exclude_audited_tokens', value: coerceBoolean(autoAnalysis.exclude_audited_tokens, true) ? '1' : '0' },
          { key: 'web_security.https_enabled', value: httpsEnabled ? '1' : '0' },
          { key: 'web_security.tls_cert_path', value: tlsCertPath },
          { key: 'web_security.tls_key_path', value: tlsKeyPath },
        ]);

        upsertChainSettings(chainConfigs.map((row) => ({
          chain: String(row.chain || '').trim().toLowerCase(),
          blocksPerScan: coercePositiveInt(row.blocks_per_scan, 75),
          chainbaseKeys: [],
          rpcUrls: [],
          multicall3Address: String(row.multicall3 || '').trim().toLowerCase(),
        })).filter((row) => row.chain));

        replaceAiAuditProviders(normalizedProviders);
        replaceAiAuditModels(normalizedModels);
        replaceWhitelistPatterns(whitelistPatterns.map((row, index) => ({
          name: String(row.name || '').trim(),
          hexPattern: String((row.hex_pattern ?? row.hexPattern) || '').trim(),
          patternType: String((row.pattern_type ?? row.patternType) || 'selector').trim().toLowerCase() || 'selector',
          score: Number.isFinite(Number(row.score)) ? Number(row.score) : (index + 1),
          description: String(row.description || '').trim(),
        })));
        reloadRuntimeConfig();

        sendJson(res, 200, {
          ok: true,
          hot_applied: true,
          settings: await buildSettingsPayload(),
        });
        return;
      }

      if (method === 'GET') {
        await serveStatic(reqPath, res);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error('Web request failed', err);
      sendJson(res, 500, { error: (err as Error).message || 'Internal server error' });
    }
  };

  const startupSecurity = getWebSecurityConfig();
  const useHttps = startupSecurity.httpsEnabled;
  if (useHttps && (!startupSecurity.tlsCertPath || !startupSecurity.tlsKeyPath)) {
    throw new Error('HTTPS is enabled but TLS cert path or key path is missing');
  }
  const server = useHttps
    ? createHttpsServer({
        key: await readFile(resolveProjectPath(startupSecurity.tlsKeyPath)),
        cert: await readFile(resolveProjectPath(startupSecurity.tlsCertPath)),
      }, requestHandler)
    : createServer(requestHandler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      logger.info(`Web UI ready at ${useHttps ? 'https' : 'http'}://${host}:${port}`);
      resolve();
    });
  });
  server.on('close', () => {
    unsubscribeAutoAnalysis();
    unsubscribeAiAudit();
    unsubscribePatternSync();
  });
}

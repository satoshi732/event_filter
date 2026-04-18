import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';
import { logger } from '../utils/logger.js';
import { createDashboardReadCache } from './read-cache.js';
import { createApiRouteHandler } from './api-handlers.js';
import {
  createAuthenticatedSession,
  clearSessionCookie,
  enforceAuthentication,
  getAuthenticatedSession,
  isPublicRequest,
  revokeAuthenticatedSession,
  setSessionCookie,
} from './auth.js';
import { handleLoginRoutes } from './login-routes.js';
import { appPageRoutes, handleAppPageRoutes } from './page-routes.js';
import { isStaticAssetRequest, serveStaticAsset } from './static-assets.js';
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
  type AiAuditEvent,
  startAiAuditWorker,
} from '../modules/ai-audit-runner/index.js';
import {
  configureAutoAnalysisEngine,
  getAutoAnalysisRuntimeConfig,
  getAutoAnalysisStatus,
  startAutoAnalysis,
  startAutoAnalysisEngine,
  stopAutoAnalysis,
  subscribeAutoAnalysisStatus,
} from '../modules/auto-analysis/index.js';
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

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
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

function isAiAuditRateLimitFailure(event: AiAuditEvent): boolean {
  if (event.kind !== 'failed' || event.status !== 'failed') return false;
  const message = String(event.error || '').trim().toLowerCase();
  if (!message) return false;
  return /rate[\s-]?limit/.test(message)
    || /too many requests/.test(message)
    || /\b429\b/.test(message)
    || /quota exceeded/.test(message);
}

function serializeAutoAnalysisRuntimeConfig() {
  const config = getAutoAnalysisRuntimeConfig();
  return {
    queue_capacity: config.queueCapacity,
    round_audit_limit: config.roundAuditLimit,
    round_rest_seconds: config.roundRestSeconds,
    stop_at_datetime: config.stopAtDateTime || '',
    token_share_percent: config.tokenSharePercent,
    contract_share_percent: config.contractSharePercent,
    provider: config.provider,
    model: config.model,
    contract_min_tvl_usd: config.contractMinTvlUsd,
    token_min_price_usd: config.tokenMinPriceUsd,
    require_token_sync: config.requireTokenSync,
    require_contract_selectors: config.requireContractSelectors,
    skip_seen_contracts: config.skipSeenContracts,
    one_per_contract_pattern: config.onePerContractPattern,
    retry_failed_audits: config.retryFailedAudits,
    exclude_audited_contracts: config.excludeAuditedContracts,
    exclude_audited_tokens: config.excludeAuditedTokens,
  };
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
      case 'deployed':
        delta = compareStringLike(a.token_created_at || '', b.token_created_at || '');
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
      auto_analysis: serializeAutoAnalysisRuntimeConfig(),
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

async function renderPage(res: ServerResponse, viewPath: string, data: Record<string, unknown>): Promise<void> {
  try {
    const html = await ejs.renderFile(path.join(VIEWS_DIR, viewPath), data, { async: true });
    sendHtml(res, 200, html);
  } catch (err) {
    logger.error('Template render failed', err);
    sendJson(res, 500, { error: 'Template render failed' });
  }
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
  const readCache = createDashboardReadCache<
    PipelineRunResult,
    DashboardContractSummary[],
    DashboardTokenSummary[],
    ReturnType<typeof buildContractDetail>
  >();

  function runCacheKey(run: PipelineRunResult): string {
    return `${run.chain}:${run.generated_at}:${run.block_from}:${run.block_to}:${run.token_count}`;
  }

  function invalidateReadCaches(chain?: string): void {
    readCache.invalidate(chain);
  }

  function invalidateDerivedReadCaches(chain?: string): void {
    readCache.invalidateDerived(chain);
  }

  function resolveRun(chain: string): PipelineRunResult | null {
    const normalizedChain = chain.toLowerCase();
    return readCache.resolvePersistedRun(normalizedChain, () => buildPersistedRun(normalizedChain) ?? null);
  }

  function resolveDashboardContracts(chain: string, run: PipelineRunResult): DashboardContractSummary[] {
    const normalizedChain = chain.toLowerCase();
    const key = runCacheKey(run);
    return readCache.resolveDashboardContracts(
      normalizedChain,
      key,
      () => buildDashboardContracts(normalizedChain, run),
    );
  }

  function resolveDashboardTokens(chain: string, run: PipelineRunResult): DashboardTokenSummary[] {
    const normalizedChain = chain.toLowerCase();
    const key = runCacheKey(run);
    return readCache.resolveDashboardTokens(
      normalizedChain,
      key,
      () => buildDashboardTokens(normalizedChain, run),
    );
  }

  function resolveContractDetail(chain: string, run: PipelineRunResult, contract: string) {
    const normalizedChain = chain.toLowerCase();
    const normalizedContract = contract.toLowerCase();
    const key = `${normalizedChain}:${normalizedContract}`;
    const runKey = runCacheKey(run);
    return readCache.resolveContractDetail(
      key,
      runKey,
      () => buildContractDetail(normalizedChain, run, normalizedContract),
    );
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
      readCache.resolvePersistedRun(chain, () => buildPersistedRun(chain) ?? null);
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
    if (isAiAuditRateLimitFailure(event)) {
      const autoStatus = getAutoAnalysisStatus();
      if (autoStatus.enabled) {
        const detail = String(event.error || '').trim();
        const reason = `Auto analysis stopped after AI backend rate limit on ${event.provider}/${event.model} for ${event.targetType} ${event.chain}:${event.targetAddr}`;
        stopAutoAnalysis(detail ? `${reason}: ${detail}` : reason);
        void broadcastStateSnapshot();
      }
    }
    broadcastNamedEvent('ai-audit', event);
  });
  const unsubscribePatternSync = subscribePatternSyncEvents((event) => {
    broadcastNamedEvent('pattern-sync', event);
  });
  startAutoAnalysisEngine();

  const handleApiRoute = createApiRouteHandler({
    chains,
    state,
    rootDir: ROOT,
    stateStreamClients,
    sendJson,
    sendHtml,
    readJsonBody,
    readTextFileSafe,
    escapeHtml,
    resolveReportFilePath,
    resolveProjectPath,
    buildStatePayload,
    buildSettingsPayload,
    buildAiAuditConfigPayload,
    broadcastStateSnapshot,
    broadcastNamedEvent,
    invalidateReadCaches,
    invalidateDerivedReadCaches,
    resolveRun,
    resolveDashboardContracts,
    resolveDashboardTokens,
    resolveContractDetail,
    latestRunMeta,
    handleRun,
    applyDashboardContractQuery,
    applyDashboardTokenQuery,
    parsePositiveInt,
    coerceStringArray,
    coercePositiveInt,
    coerceBoolean,
    normalizeAiModelRows,
    writeSseEvent,
  });

  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    const requestStartedAt = Date.now();
    try {
      const method = req.method ?? 'GET';
      const security = getWebSecurityConfig();
      const userAuth = getUserAuthConfig();
      const requestProtocol = security.httpsEnabled ? 'https' : 'http';
      const url = new URL(req.url ?? '/', `${requestProtocol}://localhost`);
      const reqPath = url.pathname;
      const activeSession = getAuthenticatedSession(req);
      const isApiRequest = reqPath.startsWith('/api/');
      const isPageRequest = method === 'GET' && appPageRoutes.has(reqPath);
      const publicRequest = isPublicRequest(method, reqPath, isStaticAssetRequest);
      const shouldLogRequest = isApiRequest
        || isPageRequest
        || reqPath === '/login'
        || reqPath === '/api/login'
        || reqPath === '/api/logout';

      if (shouldLogRequest) {
        res.once('finish', () => {
          const durationMs = Date.now() - requestStartedAt;
          const status = res.statusCode || 0;
          if (durationMs < 250 && status < 400) return;
          const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : durationMs >= 1500 ? 'warn' : 'info';
          logger[level](
            `[web] ${method} ${reqPath}${url.search || ''} -> ${status} in ${durationMs}ms`,
          );
        });
      }

      if (!enforceAuthentication(req, res, {
        method,
        reqPath,
        isApiRequest,
        isPageRequest,
        isPublicRequest: publicRequest,
        userAuth,
        activeSession,
        sendJson,
      })) {
        return;
      }

      if (await handleLoginRoutes({
        method,
        reqPath,
        req,
        res,
        url,
        userAuth,
        activeSession,
        secureCookies: security.httpsEnabled,
        renderPage,
        readJsonBody,
        sendJson,
        createAuthenticatedSession,
        revokeAuthenticatedSession,
        setSessionCookie,
        clearSessionCookie,
      })) {
        return;
      }

      if (await handleAppPageRoutes({
        method,
        reqPath,
        res,
        authEnabled: userAuth.authEnabled,
        currentUser: activeSession?.session.username || '',
        renderPage,
      })) {
        return;
      }

      if (await handleApiRoute(req, res, reqPath, method, url)) {
        return;
      }

      if (method === 'GET') {
        await serveStaticAsset(reqPath, PUBLIC_DIR, res);
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

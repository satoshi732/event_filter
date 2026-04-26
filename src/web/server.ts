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
  isAdminAuthUser,
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
  getAvailableChains,
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
  getDashboardInventorySummary,
  getGlobalSyncPatternDailySeries,
  getUserDailyActivitySeries,
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
import { findUserAuthAccount, getAllowedChainsForUser, getUserAuthConfig } from '../utils/user-auth.js';
import {
  escapeHtml,
  readJsonBody,
  readTextFileSafe,
  resolveProjectPath,
  resolveReportFilePath,
  sendHtml,
  sendJson,
} from './http-helpers.js';
import {
  coerceBoolean,
  coercePositiveInt,
  coerceStringArray,
  normalizeAiModelRows,
  parsePositiveInt,
  sanitizeRuntimeConfig,
} from './request-utils.js';
import { applyDashboardContractQuery, applyDashboardTokenQuery } from './dashboard-query.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PUBLIC_DIR = path.join(ROOT, 'public');
const VIEWS_DIR = path.join(ROOT, 'views');

interface WebState {
  running: boolean;
  runningChain: string | null;
  runningOwnerUsername: string | null;
  progress: PipelineProgressUpdate | null;
  latestRuns: Map<string, PipelineRunResult>;
}

interface RequestedRunRange {
  fromBlock?: number | null;
  toBlock?: number | null;
  deltaBlocks?: number | null;
}

type StateStreamClient = ServerResponse<IncomingMessage> & {
  __stateHeartbeat?: NodeJS.Timeout;
  __username?: string;
};

function isAiAuditRateLimitFailure(event: AiAuditEvent): boolean {
  if (event.kind !== 'failed' || event.status !== 'failed') return false;
  const message = String(event.error || '').trim().toLowerCase();
  if (!message) return false;
  return /rate[\s-]?limit/.test(message)
    || /too many requests/.test(message)
    || /\b429\b/.test(message)
    || /quota exceeded/.test(message);
}

function serializeAutoAnalysisRuntimeConfig(username = '') {
  const config = getAutoAnalysisRuntimeConfig(username);
  return {
    selected_chains: config.selectedChains,
    chain_ratios: config.chainRatios,
    chain_configs: Object.fromEntries(
      Object.entries(config.chainConfigs || {}).map(([chain, row]) => [chain, {
        from_block: row.fromBlock ?? '',
        to_block: row.toBlock ?? '',
        delta_blocks: row.deltaBlocks ?? '',
        token_share_percent: row.tokenSharePercent,
        contract_share_percent: row.contractSharePercent,
      }]),
    ),
    queue_capacity: config.queueCapacity,
    continue_on_empty_round: config.continueOnEmptyRound,
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

async function buildSettingsPayload(username = '') {
  const snapshot = getConfigSnapshot();
  const chainConfigs = getChainConfigsSnapshot();
  const security = getWebSecurityConfig();
  const userAuth = getUserAuthConfig();
  const effectiveUsername = String(username || userAuth.username || '').trim();
  const allChains = Object.keys(chainConfigs);
  const allowedChains = getAllowedChainsForUser(userAuth, effectiveUsername, Object.keys(chainConfigs));
  const currentUserRecord = findUserAuthAccount(userAuth, effectiveUsername) || userAuth.users[0] || null;

  return {
    runtime_settings: {
      chainbase_keys: snapshot.chainbase_keys ?? [],
      rpc_keys: snapshot.rpc_keys ?? [],
      monitored_chains: getMonitoredChains().filter((chain) => allowedChains.includes(chain)),
      poll_interval_ms: getPollIntervalMs(),
      debug: Boolean(snapshot.debug),
      pattern_sync: snapshot.pattern_sync ?? null,
      pancakeswap_price: snapshot.pancakeswap_price ?? { max_req_per_second: 2, max_req_per_minute: 90 },
      ai_audit_backend: snapshot.ai_audit_backend ?? getAiAuditBackendConfig(),
      auto_analysis: serializeAutoAnalysisRuntimeConfig(effectiveUsername),
      account: {
        username: effectiveUsername,
        role: currentUserRecord?.role || userAuth.role,
        ai_api_key: currentUserRecord?.aiApiKey || '',
        has_ai_api_key: Boolean(currentUserRecord?.aiApiKey),
        allowed_chains: currentUserRecord?.allowedChains || [],
        daily_review_target: currentUserRecord?.dailyReviewTarget || 200,
        available_chains: allChains,
      },
      access: {
        auth_enabled: userAuth.authEnabled,
        username: userAuth.username,
        role: userAuth.role,
        users: userAuth.users.map((user) => ({
          username: user.username,
          role: user.role,
          has_ai_api_key: Boolean(user.aiApiKey),
          allowed_chains: user.allowedChains || [],
          daily_review_target: user.dailyReviewTarget || 200,
        })),
        password: '',
        has_password: Boolean(userAuth.passwordHash),
        auth_source: 'state.db / auth_users',
        https_enabled: security.httpsEnabled,
        tls_cert_path: security.tlsCertPath,
        tls_key_path: security.tlsKeyPath,
      },
    },
    chain_configs: Object.entries(chainConfigs).filter(([chain]) => allowedChains.includes(chain)).map(([chain, cfg]) => ({
      chain,
      name: cfg.name,
      chain_id: cfg.chainId,
      table_prefix: cfg.tablePrefix,
      blocks_per_scan: cfg.blocksPerScan,
      pipeline_source: cfg.pipelineSource,
      chainbase_keys: cfg.chainbaseKeys,
      rpc_network: cfg.rpcNetwork,
      multicall3: cfg.multicall3Address,
      wrapped_native_token_address: cfg.wrappedNativeTokenAddress,
      native_currency: cfg.nativeCurrency,
    })),
    ai_providers: getAiAuditProviderConfigs(),
    ai_models: getAiAuditModelConfigs(),
    whitelist_patterns: getWhitelistPatterns(),
    runtime_config: sanitizeRuntimeConfig(snapshot),
    hot_applied: true,
  };
}

function buildDashboardHomePayload(username: string, visibleChains: string[]) {
  const userAuth = getUserAuthConfig();
  const effectiveUsername = String(username || userAuth.username || '').trim().toLowerCase();
  const account = findUserAuthAccount(userAuth, effectiveUsername);
  const autoStatus = getAutoAnalysisStatus(effectiveUsername);
  const activitySeries = getUserDailyActivitySeries(effectiveUsername, 14);
  const todayActivity = activitySeries[activitySeries.length - 1] || null;
  const dailyReviewTarget = account?.dailyReviewTarget || 200;
  const todayReviewCount = Number(todayActivity?.review_count || 0);
  return {
    username: effectiveUsername,
    activity_series: activitySeries,
    global_sync_series: getGlobalSyncPatternDailySeries(14),
    daily_assign: {
      target: dailyReviewTarget,
      review_count: todayReviewCount,
      percent: dailyReviewTarget > 0 ? Math.max(0, Math.min(100, Math.round((todayReviewCount / dailyReviewTarget) * 100))) : 0,
    },
    inventory: getDashboardInventorySummary(visibleChains),
    auto_status: {
      enabled: autoStatus.enabled,
      phase: autoStatus.phase,
      chain: autoStatus.chain,
      queued: autoStatus.queuedThisRound,
      running: autoStatus.runningThisRound,
      completed: autoStatus.completedThisRound,
      failed: autoStatus.failedThisRound,
      capacity: autoStatus.capacity,
      cycle: autoStatus.cycle,
      last_action: autoStatus.lastAction,
      updated_at: autoStatus.updatedAt,
    },
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
  _chains: string[],
  host: string,
  port: number,
): Promise<void> {
  startAutoPatternSyncLoop();
  startAiAuditWorker();

  const state: WebState = {
    running: false,
    runningChain: null,
    runningOwnerUsername: null,
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

  async function buildStatePayload(username = '') {
    const syncStatus = await getPatternSyncStatus();
    const userAuth = getUserAuthConfig();
    const effectiveUsername = String(username || userAuth.username || '').trim().toLowerCase();
    const runtimeChains = getAvailableChains();
    const visibleChains = getAllowedChainsForUser(userAuth, effectiveUsername, runtimeChains);
    const latestRuns = visibleChains.flatMap((chain) => {
      const inMemory = state.latestRuns.get(chain);
      if (inMemory) return [latestRunMeta(inMemory)];
      const persisted = latestPersistedRunMeta(chain);
      return persisted ? [persisted] : [];
    }).sort((left, right) =>
      String(right.generated_at || '').localeCompare(String(left.generated_at || '')),
    );

    const viewer = String(username || '').trim().toLowerCase();
    const runningOwner = String(state.runningOwnerUsername || '').trim().toLowerCase();
    const ownsActiveRound = Boolean(state.running && runningOwner && viewer === runningOwner);

    return {
      running: ownsActiveRound,
      running_chain: ownsActiveRound && state.runningChain && visibleChains.includes(state.runningChain) ? state.runningChain : null,
      progress: ownsActiveRound && state.progress && visibleChains.includes(String(state.progress.chain || '').toLowerCase()) ? state.progress : null,
      chains: visibleChains,
      default_chain: visibleChains[0] ?? null,
      latest_runs: latestRuns,
      sync_status: syncStatus,
      auto_analysis: getAutoAnalysisStatus(effectiveUsername),
      dashboard_home: buildDashboardHomePayload(effectiveUsername, visibleChains),
    };
  }

  function writeSseEvent(client: ServerResponse, event: string, payload: unknown): void {
    client.write(`event: ${event}\n`);
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function broadcastNamedEvent(event: string, payload: unknown): void {
    if (!stateStreamClients.size) return;
    const userAuth = getUserAuthConfig();
    const runtimeChains = getAvailableChains();
    const payloadChain = String((payload as { chain?: string } | null)?.chain || '').trim().toLowerCase();
    const payloadUsername = String((payload as { username?: string; ownerUsername?: string } | null)?.username || (payload as { ownerUsername?: string } | null)?.ownerUsername || '').trim().toLowerCase();
    for (const client of stateStreamClients) {
      if (client.destroyed || client.writableEnded) {
        stateStreamClients.delete(client);
        continue;
      }
      const viewer = String(client.__username || '').trim().toLowerCase();
      if (event === 'auto-analysis' && payloadUsername && viewer !== payloadUsername) continue;
      if (payloadChain) {
        const allowedChains = getAllowedChainsForUser(userAuth, viewer, runtimeChains);
        if (!allowedChains.includes(payloadChain)) continue;
      }
      writeSseEvent(client, event, payload);
    }
  }

  async function broadcastStateSnapshot(): Promise<void> {
    if (!stateStreamClients.size) return;
    for (const client of stateStreamClients) {
      if (client.destroyed || client.writableEnded) {
        stateStreamClients.delete(client);
        continue;
      }
      const payload = await buildStatePayload(String(client.__username || ''));
      writeSseEvent(client, 'state', payload);
    }
  }

  async function handleRun(
    chain: string,
    ownerUsername: string | null = '',
    range: RequestedRunRange = {},
  ): Promise<PipelineRunResult> {
    if (state.running) {
      throw new Error(`Scan already running for ${state.runningChain ?? 'unknown chain'}`);
    }

    const owner = String(ownerUsername || '').trim().toLowerCase();
    state.running = true;
    state.runningChain = chain;
    state.runningOwnerUsername = owner || null;
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
      ownerUsername: owner || null,
      ts: new Date().toISOString(),
    });
    await broadcastStateSnapshot();

    try {
      const run = await runPipeline(chain, {
        range,
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
        ownerUsername: owner || null,
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
        ownerUsername: owner || null,
        error: (err as Error).message || 'Unknown error',
        ts: new Date().toISOString(),
      });
      await broadcastStateSnapshot();
      throw err;
    } finally {
      state.running = false;
      state.runningChain = null;
      state.runningOwnerUsername = null;
      await broadcastStateSnapshot();
    }
  }

  configureAutoAnalysisEngine({
    runRound: handleRun,
    isRoundRunning: () => state.running,
  });
  const unsubscribeAutoAnalysis = subscribeAutoAnalysisStatus((event) => {
    broadcastNamedEvent('auto-analysis', event);
  });
  const unsubscribeAiAudit = subscribeAiAuditEvents((event) => {
    invalidateReadCaches(event.chain);
    if (isAiAuditRateLimitFailure(event)) {
      const ownerUsername = String(event.ownerUsername || '').trim().toLowerCase();
      const autoStatus = ownerUsername ? getAutoAnalysisStatus(ownerUsername) : null;
      if (autoStatus?.enabled && ownerUsername) {
        const detail = String(event.error || '').trim();
        const reason = `Auto analysis stopped after AI backend rate limit on ${event.provider}/${event.model} for ${event.targetType} ${event.chain}:${event.targetAddr}`;
        stopAutoAnalysis(ownerUsername, detail ? `${reason}: ${detail}` : reason);
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
    state,
    rootDir: ROOT,
    stateStreamClients,
    sendJson,
    sendHtml,
    readJsonBody,
    readTextFileSafe,
    escapeHtml,
    resolveReportFilePath: (rawPath) => resolveReportFilePath(ROOT, rawPath),
    resolveProjectPath: (rawPath) => resolveProjectPath(ROOT, rawPath),
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
      const currentUser = activeSession?.session.username || '';
      const currentIsAdmin = !userAuth.authEnabled || isAdminAuthUser(userAuth, currentUser);
      const currentUserRole = currentIsAdmin ? 'admin' : 'user';
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
        currentUser,
        currentUserRole,
        isAdmin: currentIsAdmin,
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
        key: await readFile(resolveProjectPath(ROOT, startupSecurity.tlsKeyPath)),
        cert: await readFile(resolveProjectPath(ROOT, startupSecurity.tlsCertPath)),
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

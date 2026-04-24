import type { IncomingMessage, ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import {
  getAvailableChains,
  getDefaultAiAuditModel,
  getDefaultAiAuditProvider,
  normalizeAiAuditModel,
  normalizeAiAuditProvider,
  reloadRuntimeConfig,
} from '../config.js';
import {
  getWhitelistPatterns,
  getTokenRegistry,
  listTokenPriceSyncTargets,
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
  replaceChainSettings,
  upsertTokenPriceBatch,
} from '../db.js';
import {
  getPatternSyncStatus,
  prepareTokenPatternReview,
  pullPatterns,
  pushPatterns,
  queueSeenContractReviewTarget,
  saveContractReview,
  verifyPatterns,
} from '../modules/selectors-manager/index.js';
import {
  enqueueContractAiAudit,
  enqueueTokenAiAudit,
  getContractAiAuditPlan,
} from '../modules/ai-audit-runner/index.js';
import {
  getAutoAnalysisStatus,
  setAutoAnalysisRuntimeConfig,
  startAutoAnalysis,
  stopAutoAnalysis,
} from '../modules/auto-analysis/index.js';
import { updateManualContractLinkage } from '../modules/contract-manager/index.js';
import { withLiveReviews, type DashboardContractSummary, type DashboardTokenSummary, type LatestRunMeta } from '../modules/dashboard/read-model.js';
import { deriveAiAuditLifecycleStatus } from '../db/audit-state.js';
import type { PipelineRunResult } from '../pipeline.js';
import { getAuthenticatedSession, isAdminAuthUser, renameAuthenticatedSessions } from './auth.js';
import { findUserAuthAccount, getAllowedChainsForUser, getUserAuthConfig, updateOwnUserAuthAccount } from '../utils/user-auth.js';
import { verifyPassword } from '../utils/web-security.js';
import { getTokenPricesBatch } from '../utils/rpc.js';

type StateStreamClient = ServerResponse<IncomingMessage> & {
  __stateHeartbeat?: NodeJS.Timeout;
  __username?: string;
};

interface WebStateLike {
  running: boolean;
  runningChain: string | null;
}

interface ApiRouteHandlerDeps {
  state: WebStateLike;
  rootDir: string;
  stateStreamClients: Set<StateStreamClient>;
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void;
  sendHtml: (res: ServerResponse, statusCode: number, html: string) => void;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  readTextFileSafe: (filePath: string) => Promise<string>;
  escapeHtml: (value: string) => string;
  resolveReportFilePath: (rawPath: string) => string;
  resolveProjectPath: (rawPath: string) => string;
  buildStatePayload: (username?: string) => Promise<unknown>;
  buildSettingsPayload: (username?: string) => Promise<unknown>;
  buildAiAuditConfigPayload: () => unknown;
  broadcastStateSnapshot: () => Promise<void>;
  broadcastNamedEvent: (event: string, payload: unknown) => void;
  invalidateReadCaches: (chain?: string) => void;
  invalidateDerivedReadCaches: (chain?: string) => void;
  resolveRun: (chain: string) => PipelineRunResult | null;
  resolveDashboardContracts: (chain: string, run: PipelineRunResult) => DashboardContractSummary[];
  resolveDashboardTokens: (chain: string, run: PipelineRunResult) => DashboardTokenSummary[];
  resolveContractDetail: (chain: string, run: PipelineRunResult, contract: string) => unknown;
  latestRunMeta: (run: PipelineRunResult) => LatestRunMeta;
  handleRun: (chain: string, ownerUsername?: string) => Promise<PipelineRunResult>;
  applyDashboardContractQuery: (
    rows: DashboardContractSummary[],
    search: string,
    risk: string,
    link: string,
    sortKey: string,
    sortDir: string,
    page: number,
    pageSize: number,
  ) => { rows: DashboardContractSummary[]; totalRows: number; page: number; pageSize: number };
  applyDashboardTokenQuery: (
    rows: DashboardTokenSummary[],
    search: string,
    sortKey: string,
    sortDir: string,
    page: number,
    pageSize: number,
  ) => { rows: DashboardTokenSummary[]; totalRows: number; page: number; pageSize: number };
  parsePositiveInt: (value: string | null, fallback: number) => number;
  coerceStringArray: (value: unknown) => string[];
  coercePositiveInt: (value: unknown, fallback: number) => number;
  coerceBoolean: (value: unknown, fallback?: boolean) => boolean;
  normalizeAiModelRows: (
    providers: Array<{ provider: string; enabled: boolean; position: number }>,
    models: Array<{ provider: string; model: string; enabled: boolean; isDefault: boolean; position: number }>,
  ) => Array<{ provider: string; model: string; enabled: boolean; isDefault: boolean; position: number }>;
  writeSseEvent: (client: ServerResponse, event: string, payload: unknown) => void;
}

function renderReportHtml(title: string, label: string, value: string, chain: string, reportPath: string, reportText: string, escapeHtml: (value: string) => string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
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
        <strong>${escapeHtml(label)}</strong> ${escapeHtml(value)}<br>
        <strong>Chain</strong> ${escapeHtml(chain)}<br>
        <strong>Report Path</strong> ${escapeHtml(reportPath)}
      </section>
      <pre><code>${escapeHtml(reportText)}</code></pre>
    </main>
  </body>
</html>`;
}

function normalizeDateTimeLocalInput(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return '';
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return '';
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function coerceAutoAnalysisRuntimeConfig(input: unknown) {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const toPositiveInt = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  const toBoolean = (value: unknown, fallback: boolean) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
  };
  const provider = normalizeAiAuditProvider(String(source.provider || '').trim());
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
  return {
    selectedChains,
    chainRatios,
    queueCapacity: toPositiveInt(source.queue_capacity, 10),
    roundAuditLimit: toPositiveInt(source.round_audit_limit, 5),
    roundRestSeconds: toPositiveInt(source.round_rest_seconds, 60),
    continueOnEmptyRound: toBoolean(source.continue_on_empty_round, false),
    stopAtDateTime: normalizeDateTimeLocalInput(source.stop_at_datetime ?? source.stop_at_time) || null,
    tokenSharePercent: toPositiveInt(source.token_share_percent, 40),
    contractSharePercent: toPositiveInt(source.contract_share_percent, 60),
    provider,
    model: normalizeAiAuditModel(provider, String(source.model || '').trim()),
    contractMinTvlUsd: Number.isFinite(Number(source.contract_min_tvl_usd)) ? Number(source.contract_min_tvl_usd) : 10000,
    tokenMinPriceUsd: Number.isFinite(Number(source.token_min_price_usd)) ? Number(source.token_min_price_usd) : 0.001,
    requireTokenSync: toBoolean(source.require_token_sync, true),
    requireContractSelectors: toBoolean(source.require_contract_selectors, true),
    skipSeenContracts: toBoolean(source.skip_seen_contracts, true),
    onePerContractPattern: toBoolean(source.one_per_contract_pattern, true),
    retryFailedAudits: toBoolean(source.retry_failed_audits, true),
    excludeAuditedContracts: toBoolean(source.exclude_audited_contracts, true),
    excludeAuditedTokens: toBoolean(source.exclude_audited_tokens, true),
  };
}

export function createApiRouteHandler(deps: ApiRouteHandlerDeps) {
  return async function handleApiRoute(
    req: IncomingMessage,
    res: ServerResponse,
    reqPath: string,
    method: string,
    url: URL,
  ): Promise<boolean> {
    const {
      state,
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
    } = deps;

    if (!reqPath.startsWith('/api/')) return false;
    const requestUserAuth = getUserAuthConfig();
    const requestSession = getAuthenticatedSession(req);
    const requestUsername = requestSession?.session.username || '';
    const requestIsAdmin = !requestUserAuth.authEnabled
      || isAdminAuthUser(requestUserAuth, requestUsername);
    const requestKnownChains = getAvailableChains();
    const requestAllowedChains = getAllowedChainsForUser(requestUserAuth, requestUsername, requestKnownChains);
    const requireAdmin = () => {
      if (requestIsAdmin) return true;
      sendJson(res, 403, { error: 'Admin privileges are required for this action' });
      return false;
    };
    const normalizeRequestedChain = (value: unknown, fallback = requestAllowedChains[0] || '') =>
      String(value || fallback || '').trim().toLowerCase();
    const requireAllowedChain = (chain: string) => {
      if (requestAllowedChains.includes(chain)) return true;
      sendJson(res, 403, { error: `Chain access denied: ${chain || 'unknown'}` });
      return false;
    };
    const buildAccountPayload = (username = requestUsername, config = requestUserAuth) => {
      const account = findUserAuthAccount(config, username);
      return {
        username: account?.username || username,
        role: account?.role || 'user',
        ai_api_key: account?.aiApiKey || '',
        has_ai_api_key: Boolean(account?.aiApiKey),
        allowed_chains: account?.allowedChains || [],
        available_chains: requestKnownChains,
      };
    };

    if (reqPath === '/api/state' && method === 'GET') {
      sendJson(res, 200, await buildStatePayload(requestUsername));
      return true;
    }

    if (reqPath === '/api/account' && method === 'GET') {
      if (!requestUserAuth.authEnabled) {
        sendJson(res, 400, { error: 'Authentication is disabled' });
        return true;
      }
      sendJson(res, 200, { account: buildAccountPayload() });
      return true;
    }

    if (reqPath === '/api/account' && method === 'POST') {
      if (!requestUserAuth.authEnabled) {
        sendJson(res, 400, { error: 'Authentication is disabled' });
        return true;
      }
      const account = findUserAuthAccount(requestUserAuth, requestUsername);
      if (!account) {
        sendJson(res, 404, { error: 'Current user was not found' });
        return true;
      }
      const body = await readJsonBody(req);
      const nextUsername = String(body.username ?? account.username).trim();
      const aiApiKey = String(body.ai_api_key ?? body.aiApiKey ?? '').trim();
      const currentPassword = String(body.current_password || '');
      const newPassword = String(body.new_password || '');
      const confirmPassword = String(body.confirm_password || '');
      const allowedChains = coerceStringArray(body.allowed_chains)
        .map((chain) => String(chain || '').trim().toLowerCase())
        .filter((chain) => requestKnownChains.includes(chain));
      const changingCredentials = nextUsername.toLowerCase() !== account.username.toLowerCase() || Boolean(newPassword);
      if (changingCredentials && !verifyPassword(currentPassword, account.passwordHash)) {
        sendJson(res, 400, { error: 'Current password is required to change username or password' });
        return true;
      }
      if (newPassword && newPassword !== confirmPassword) {
        sendJson(res, 400, { error: 'New password confirmation does not match' });
        return true;
      }
      try {
        const updated = updateOwnUserAuthAccount(requestUsername, {
          username: nextUsername,
          newPassword,
          aiApiKey,
          allowedChains,
        });
        renameAuthenticatedSessions(updated.previousUsername, updated.user.username);
        sendJson(res, 200, {
          ok: true,
          account: buildAccountPayload(updated.user.username, updated.config),
        });
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message || 'Account update failed' });
      }
      return true;
    }

    if (reqPath === '/api/auto-analysis' && method === 'GET') {
      sendJson(res, 200, getAutoAnalysisStatus(requestUsername));
      return true;
    }

    if (reqPath === '/api/auto-analysis/start' && method === 'POST') {
      const body = await readJsonBody(req);
      const configInput = coerceAutoAnalysisRuntimeConfig(body.config);
      const requestedChains = configInput.selectedChains.length
        ? configInput.selectedChains
        : coerceStringArray(body.chains).map((chain) => normalizeRequestedChain(chain)).filter(Boolean);
      const fallbackChain = normalizeRequestedChain(body.chain);
      const selectedChains = requestedChains.length
        ? requestedChains
        : (fallbackChain ? [fallbackChain] : []);
      if (!selectedChains.length) {
        sendJson(res, 400, { error: 'At least one auto-analysis chain is required' });
        return true;
      }
      const unknownChain = selectedChains.find((chain) => !requestKnownChains.includes(chain));
      if (unknownChain) {
        sendJson(res, 400, { error: `Unknown chain: ${unknownChain}` });
        return true;
      }
      for (const chain of selectedChains) {
        if (!requireAllowedChain(chain)) return true;
      }
      const account = findUserAuthAccount(requestUserAuth, requestUsername);
      const config = setAutoAnalysisRuntimeConfig(requestUsername, {
        ...configInput,
        selectedChains,
        chainRatios: Object.fromEntries(
          selectedChains.map((chain) => [chain, Number(configInput.chainRatios?.[chain]) > 0 ? Number(configInput.chainRatios[chain]) : 100]),
        ),
      });
      const status = startAutoAnalysis(requestUsername, {
        backendApiKey: account?.aiApiKey || null,
        chains: selectedChains,
      });
      await broadcastStateSnapshot();
      sendJson(res, 200, { ok: true, status, config });
      return true;
    }

    if (reqPath === '/api/auto-analysis/stop' && method === 'POST') {
      const status = stopAutoAnalysis(requestUsername);
      await broadcastStateSnapshot();
      sendJson(res, 200, { ok: true, status });
      return true;
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
      client.__username = requestUsername;
      stateStreamClients.add(client);
      writeSseEvent(client, 'state', await buildStatePayload(requestUsername));

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
      return true;
    }

    if (reqPath === '/api/dashboard' && method === 'GET') {
      const chain = normalizeRequestedChain(url.searchParams.get('chain'));
      if (!requireAllowedChain(chain)) return true;
      const run = resolveRun(chain);
      if (!run) {
        sendJson(res, 404, { error: 'No results for this chain yet' });
        return true;
      }
      sendJson(res, 200, {
        run: latestRunMeta(run),
        tokens: resolveDashboardTokens(chain, run),
        contracts: resolveDashboardContracts(chain, run),
      });
      return true;
    }

    if (reqPath === '/api/contracts' && method === 'GET') {
      const chain = normalizeRequestedChain(url.searchParams.get('chain'));
      if (!requireAllowedChain(chain)) return true;
      const run = resolveRun(chain);
      if (!run) {
        sendJson(res, 404, { error: 'No results for this chain yet' });
        return true;
      }
      const result = applyDashboardContractQuery(
        resolveDashboardContracts(chain, run),
        url.searchParams.get('q') ?? '',
        (url.searchParams.get('risk') ?? 'all').toLowerCase(),
        (url.searchParams.get('link') ?? 'all').toLowerCase(),
        String(url.searchParams.get('sort_key') ?? 'total_usd'),
        String(url.searchParams.get('sort_dir') ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
        parsePositiveInt(url.searchParams.get('page'), 1),
        parsePositiveInt(url.searchParams.get('page_size'), 40),
      );
      sendJson(res, 200, {
        run: latestRunMeta(run),
        contracts: result.rows,
        total_rows: result.totalRows,
        page: result.page,
        page_size: result.pageSize,
      });
      return true;
    }

    if (reqPath === '/api/tokens' && method === 'GET') {
      const chain = normalizeRequestedChain(url.searchParams.get('chain'));
      if (!requireAllowedChain(chain)) return true;
      const run = resolveRun(chain);
      if (!run) {
        sendJson(res, 404, { error: 'No results for this chain yet' });
        return true;
      }
      const result = applyDashboardTokenQuery(
        resolveDashboardTokens(chain, run),
        url.searchParams.get('q') ?? '',
        String(url.searchParams.get('sort_key') ?? 'contracts'),
        String(url.searchParams.get('sort_dir') ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
        parsePositiveInt(url.searchParams.get('page'), 1),
        parsePositiveInt(url.searchParams.get('page_size'), 40),
      );
      sendJson(res, 200, {
        run: latestRunMeta(run),
        tokens: result.rows,
        total_rows: result.totalRows,
        page: result.page,
        page_size: result.pageSize,
      });
      return true;
    }

    if (reqPath === '/api/sync/status' && method === 'GET') {
      sendJson(res, 200, await getPatternSyncStatus());
      return true;
    }

    if (reqPath === '/api/sync/pull' && method === 'POST') {
      const result = await pullPatterns();
      invalidateDerivedReadCaches();
      sendJson(res, 200, { ok: true, result, status: await getPatternSyncStatus() });
      return true;
    }

    if (reqPath === '/api/sync/push' && method === 'POST') {
      const result = await pushPatterns();
      invalidateDerivedReadCaches();
      sendJson(res, 200, { ok: true, result, status: await getPatternSyncStatus() });
      return true;
    }

    if (reqPath === '/api/sync/verify' && method === 'POST') {
      const result = await verifyPatterns();
      sendJson(res, 200, { ok: true, result, status: await getPatternSyncStatus() });
      return true;
    }

    if (reqPath === '/api/seen-contract' && method === 'POST') {
      const body = await readJsonBody(req);
      const chain = normalizeRequestedChain(body.chain, '');
      const address = typeof body.address === 'string' ? body.address.toLowerCase() : '';
      const targetKind = typeof body.target_kind === 'string' ? body.target_kind.toLowerCase() : 'auto';
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if (!chain || !address || !label) {
        sendJson(res, 400, { error: 'chain, address, and label are required' });
        return true;
      }
      if (!requireAllowedChain(chain)) return true;
      const hash = queueSeenContractReviewTarget(chain, address, label, targetKind);
      const status = await getPatternSyncStatus();
      sendJson(res, 200, { ok: true, hash, status });
      broadcastNamedEvent('review-updated', {
        kind: 'queued-contract-review', chain, targetType: 'contract', targetAddr: address, targetKind, hash, ts: new Date().toISOString(),
      });
      broadcastNamedEvent('pattern-sync', {
        kind: 'review-queue', result: { hash, targetKind, action: 'queue' }, status, ts: new Date().toISOString(),
      });
      return true;
    }

    if (reqPath === '/api/review' && method === 'POST') {
      const body = await readJsonBody(req);
      const chain = normalizeRequestedChain(body.chain, '');
      const address = typeof body.address === 'string' ? body.address.toLowerCase() : '';
      const targetKind = typeof body.target_kind === 'string' ? body.target_kind.toLowerCase() : 'auto';
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      const reviewText = typeof body.review_text === 'string' ? body.review_text.trim() : '';
      const exploitable = Boolean(body.exploitable);
      if (!chain || !address || !label) {
        sendJson(res, 400, { error: 'chain, address, and label are required' });
        return true;
      }
      if (!requireAllowedChain(chain)) return true;
      const result = saveContractReview({ chain, address, targetKind, label, reviewText, exploitable });
      invalidateDerivedReadCaches(chain);
      const status = await getPatternSyncStatus();
      sendJson(res, 200, { ok: true, hash: result.hash, persisted_only: result.persistedOnly, status });
      broadcastNamedEvent('review-updated', {
        kind: 'saved-contract-review', chain, targetType: 'contract', targetAddr: address, targetKind, label, exploitable, hash: result.hash, persistedOnly: result.persistedOnly, ts: new Date().toISOString(),
      });
      broadcastNamedEvent('pattern-sync', {
        kind: 'review-save', result: { hash: result.hash, targetKind, action: 'save', persistedOnly: result.persistedOnly }, status, ts: new Date().toISOString(),
      });
      return true;
    }

    if (reqPath === '/api/contract-analysis/request' && method === 'POST') {
      const body = await readJsonBody(req);
      const chain = normalizeRequestedChain(body.chain, '');
      const contract = typeof body.contract === 'string' ? body.contract.toLowerCase() : '';
      if (!chain || !contract) {
        sendJson(res, 400, { error: 'chain and contract are required' });
        return true;
      }
      if (!requireAllowedChain(chain)) return true;
      const title = typeof body.title === 'string' ? body.title.trim() : 'AI Auto Audit';
      const provider = normalizeAiAuditProvider(typeof body.provider === 'string' ? body.provider.trim() : getDefaultAiAuditProvider());
      const model = normalizeAiAuditModel(provider, typeof body.model === 'string' ? body.model.trim() : getDefaultAiAuditModel(provider));
      const plan = getContractAiAuditPlan(chain, contract);
      if (!plan.accepted) {
        sendJson(res, 400, { error: plan.reason || 'Contract is not eligible for AI audit' });
        return true;
      }
      const analysis = requestContractAiAudit({ chain, contractAddr: contract, title, provider, model });
      const account = findUserAuthAccount(requestUserAuth, requestUsername);
      enqueueContractAiAudit(analysis, {
        backendApiKey: account?.aiApiKey || null,
        ownerUsername: requestUsername,
      });
      invalidateDerivedReadCaches(chain);
      sendJson(res, 200, { ok: true, analysis, plan });
      return true;
    }

    if (reqPath === '/api/token-analysis/request' && method === 'POST') {
      const body = await readJsonBody(req);
      const chain = normalizeRequestedChain(body.chain, '');
      const token = typeof body.token === 'string' ? body.token.toLowerCase() : '';
      if (!chain || !token) {
        sendJson(res, 400, { error: 'chain and token are required' });
        return true;
      }
      if (!requireAllowedChain(chain)) return true;
      const title = typeof body.title === 'string' ? body.title.trim() : 'AI Auto Audit';
      const provider = normalizeAiAuditProvider(typeof body.provider === 'string' ? body.provider.trim() : getDefaultAiAuditProvider());
      const model = normalizeAiAuditModel(provider, typeof body.model === 'string' ? body.model.trim() : getDefaultAiAuditModel(provider));
      const analysis = requestTokenAiAudit({ chain, tokenAddr: token, title, provider, model });
      const account = findUserAuthAccount(requestUserAuth, requestUsername);
      enqueueTokenAiAudit(analysis, {
        backendApiKey: account?.aiApiKey || null,
        ownerUsername: requestUsername,
      });
      invalidateDerivedReadCaches(chain);
      sendJson(res, 200, { ok: true, analysis });
      return true;
    }

    if ((reqPath === '/api/contract-analysis/result' || reqPath === '/api/token-analysis/result') && method === 'POST') {
      const body = await readJsonBody(req);
      const chain = normalizeRequestedChain(body.chain, '');
      const isContract = reqPath.includes('/contract-');
      const targetKey = isContract ? 'contract' : 'token';
      const targetAddr = typeof body[targetKey] === 'string' ? String(body[targetKey]).toLowerCase() : '';
      if (!chain || !targetAddr) {
        sendJson(res, 400, { error: `chain and ${targetKey} are required` });
        return true;
      }
      if (!requireAllowedChain(chain)) return true;
      const analysis = isContract
        ? saveContractAiAuditResult({
            chain,
            contractAddr: targetAddr,
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
          })
        : saveTokenAiAuditResult({
            chain,
            tokenAddr: targetAddr,
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
      invalidateDerivedReadCaches(chain);
      sendJson(res, 200, { ok: true, analysis });
      const lifecycle = deriveAiAuditLifecycleStatus(analysis);
      broadcastNamedEvent('ai-audit', {
        kind: lifecycle === 'requested' ? 'queued' : lifecycle,
        chain,
        targetType: isContract ? 'contract' : 'token',
        targetAddr,
        requestSession: analysis.requestSession,
        title: analysis.title,
        provider: analysis.provider,
        model: analysis.model,
        status: lifecycle,
        reportPath: analysis.resultPath,
        critical: analysis.critical,
        high: analysis.high,
        medium: analysis.medium,
        error: lifecycle === 'failed' ? 'audit failed' : null,
        ts: new Date().toISOString(),
      });
      return true;
    }

    if ((reqPath === '/api/contract-analysis/report' || reqPath === '/api/token-analysis/report') && method === 'GET') {
      const isContract = reqPath.includes('/contract-');
      const chain = normalizeRequestedChain(url.searchParams.get('chain'), '');
      const targetKey = isContract ? 'contract' : 'token';
      const targetAddr = (url.searchParams.get(targetKey) ?? '').toLowerCase();
      if (!chain || !targetAddr) {
        sendJson(res, 400, { error: `chain and ${targetKey} are required` });
        return true;
      }
      if (!requireAllowedChain(chain)) return true;
      const analysis = isContract ? getSingleContractAiAudit(chain, targetAddr) : getSingleTokenAiAudit(chain, targetAddr);
      const reportPath = analysis?.resultPath;
      if (!reportPath) {
        sendJson(res, 404, { error: `No AI report available for this ${targetKey}` });
        return true;
      }
      const filePath = resolveReportFilePath(reportPath);
      const reportText = await readTextFileSafe(filePath);
      if (!reportText) {
        sendJson(res, 404, { error: 'AI report file could not be read' });
        return true;
      }
      sendHtml(
        res,
        200,
        renderReportHtml(
          isContract ? 'AI Analysis Report' : 'Token AI Analysis Report',
          isContract ? 'Contract' : 'Token',
          targetAddr,
          chain,
          reportPath,
          reportText,
          escapeHtml,
        ),
      );
      return true;
    }

    if (reqPath === '/api/run' && method === 'POST') {
      const body = await readJsonBody(req);
      const chain = normalizeRequestedChain(body.chain);
      if (!chain || !requestKnownChains.includes(chain)) {
        sendJson(res, 400, { error: 'Invalid chain' });
        return true;
      }
      if (!requireAllowedChain(chain)) return true;
      if (state.running) {
        sendJson(res, 409, { error: 'Scan already running', running_chain: state.runningChain });
        return true;
      }
      const run = await handleRun(chain, requestUsername);
      sendJson(res, 200, { ok: true, run: latestRunMeta(run) });
      return true;
    }

    if (reqPath === '/api/token-prices/sync' && method === 'POST') {
      const targetChains = requestKnownChains.filter((chain) => requestAllowedChains.includes(chain));
      let totalTokens = 0;
      let updatedTokens = 0;
      const syncedChains: Array<{ chain: string; totalTokens: number; updatedTokens: number }> = [];

      for (const chain of targetChains) {
        const tokens = listTokenPriceSyncTargets(chain);
        if (!tokens.length) continue;
        totalTokens += tokens.length;
        const priceMap = await getTokenPricesBatch(chain, tokens);
        const rows = [...priceMap.entries()]
          .filter(([, priceUsd]) => priceUsd != null)
          .map(([token, priceUsd]) => ({
            token,
            tokenPriceUsd: Number(priceUsd),
          }));
        upsertTokenPriceBatch(chain, rows);
        updatedTokens += rows.length;
        syncedChains.push({
          chain,
          totalTokens: tokens.length,
          updatedTokens: rows.length,
        });
        invalidateReadCaches(chain);
        invalidateDerivedReadCaches(chain);
      }

      sendJson(res, 200, {
        ok: true,
        chains: syncedChains,
        total_tokens: totalTokens,
        updated_tokens: updatedTokens,
      });
      return true;
    }

    if (reqPath === '/api/results' && method === 'GET') {
      const chain = normalizeRequestedChain(url.searchParams.get('chain'));
      if (!requireAllowedChain(chain)) return true;
      const run = resolveRun(chain);
      if (!run) {
        sendJson(res, 404, { error: 'No results for this chain yet' });
        return true;
      }
      sendJson(res, 200, { ...latestRunMeta(run), tokens: resolveDashboardTokens(chain, run) });
      return true;
    }

    if (reqPath === '/api/token' && method === 'GET') {
      const chain = normalizeRequestedChain(url.searchParams.get('chain'));
      const token = (url.searchParams.get('token') ?? '').toLowerCase();
      if (!requireAllowedChain(chain)) return true;
      const run = resolveRun(chain);
      if (!run) {
        sendJson(res, 404, { error: 'No results for this chain yet' });
        return true;
      }
      const tokenResult = resolveDashboardTokens(chain, run).find((entry) => entry.token === token);
      const originalTokenResult = run.tokens.find((entry) => entry.token === token) || null;
      if (!tokenResult || !originalTokenResult) {
        sendJson(res, 404, { error: 'Token not found in latest results' });
        return true;
      }
      const analysis = getSingleTokenAiAudit(chain, token);
      const tokenRegistry = getTokenRegistry(chain, [token]).get(token);
      const tokenWithReviews = withLiveReviews(chain, originalTokenResult);
      const lifecycle = analysis ? deriveAiAuditLifecycleStatus(analysis) : 'requested';

      sendJson(res, 200, {
        run: latestRunMeta(run),
        token: {
          ...tokenWithReviews,
          review: tokenRegistry?.review ?? tokenWithReviews.review ?? '',
          is_exploitable: tokenRegistry?.isExploitable ?? Boolean(tokenWithReviews.is_exploitable),
          is_auto_audit: tokenRegistry?.isAutoAudited ?? Boolean(tokenWithReviews.is_auto_audit),
          is_manual_audit: tokenRegistry?.isManualAudited ?? Boolean(tokenWithReviews.is_manual_audit),
          auto_analysis: analysis ? {
            request_session: analysis.requestSession,
            title: analysis.title,
            provider: normalizeAiAuditProvider(analysis.provider),
            model: normalizeAiAuditModel(analysis.provider, analysis.model),
            status: lifecycle,
            requested_at: analysis.requestedAt,
            completed_at: analysis.auditedAt,
            critical: analysis.critical,
            high: analysis.high,
            medium: analysis.medium,
            report_path: analysis.resultPath,
            error: lifecycle === 'failed' ? 'audit failed' : null,
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
      return true;
    }

    if (reqPath === '/api/token-review' && method === 'POST') {
      const body = await readJsonBody(req);
      const chain = normalizeRequestedChain(body.chain, '');
      const token = typeof body.token === 'string' ? body.token.toLowerCase() : '';
      const reviewText = typeof body.review_text === 'string' ? body.review_text.trim() : '';
      const exploitable = Boolean(body.exploitable);
      if (!chain || !token) {
        sendJson(res, 400, { error: 'chain and token are required' });
        return true;
      }
      if (!requireAllowedChain(chain)) return true;
      const saved = saveTokenManualReview({ chain, token, reviewText, exploitable });
      const patternPrep = prepareTokenPatternReview({ chain, token });
      invalidateDerivedReadCaches(chain);
      sendJson(res, 200, { ok: true, token: saved, pattern: patternPrep });
      broadcastNamedEvent('review-updated', {
        kind: 'saved-token-review', chain, targetType: 'token', targetAddr: token, exploitable, ts: new Date().toISOString(),
      });
      return true;
    }

    if (reqPath === '/api/contract' && method === 'GET') {
      const chain = normalizeRequestedChain(url.searchParams.get('chain'));
      const contract = (url.searchParams.get('contract') ?? '').toLowerCase();
      if (!requireAllowedChain(chain)) return true;
      const run = resolveRun(chain);
      if (!run) {
        sendJson(res, 404, { error: 'No results for this chain yet' });
        return true;
      }
      if (!contract) {
        sendJson(res, 400, { error: 'contract is required' });
        return true;
      }
      const detail = resolveContractDetail(chain, run, contract);
      if (!detail) {
        sendJson(res, 404, { error: 'Contract not found in latest results' });
        return true;
      }
      sendJson(res, 200, {
        run: latestRunMeta(run),
        contract: detail,
        ai_config: buildAiAuditConfigPayload(),
      });
      return true;
    }

    if (reqPath === '/api/contract-linkage' && method === 'POST') {
      const body = await readJsonBody(req);
      const chain = normalizeRequestedChain(body.chain, '');
      const contract = typeof body.contract === 'string' ? body.contract.toLowerCase() : '';
      const rawLinkType = typeof body.link_type === 'string' ? body.link_type.trim().toLowerCase() : '';
      const rawLinkage = typeof body.linkage === 'string' ? body.linkage.trim().toLowerCase() : '';
      if (!chain || !contract) {
        sendJson(res, 400, { error: 'chain and contract are required' });
        return true;
      }
      if (!requireAllowedChain(chain)) return true;

      const saved = await updateManualContractLinkage({
        chain,
        contractAddr: contract,
        linkType: rawLinkType === 'proxy' || rawLinkType === 'eip7702' ? rawLinkType : null,
        linkage: rawLinkType ? rawLinkage : null,
      });
      invalidateDerivedReadCaches(chain);
      broadcastNamedEvent('data-refresh', {
        kind: 'contract-linkage-updated',
        chain,
        contract,
        link_type: saved.linkType,
        linkage: saved.linkage,
        ts: new Date().toISOString(),
      });
      sendJson(res, 200, {
        ok: true,
        linkage: {
          contract: saved.contractAddr,
          link_type: saved.linkType,
          linkage: saved.linkage,
          selector_hash: saved.selectorHash,
          contract_selector_hash: saved.contractSelectorHash,
        },
      });
      return true;
    }

    if (reqPath === '/api/settings' && method === 'GET') {
      const payload = await buildSettingsPayload(requestUsername) as Record<string, unknown>;
      if (!requestIsAdmin) {
        sendJson(res, 200, {
          runtime_settings: {
            account: buildAccountPayload(),
            auto_analysis: payload.runtime_settings && typeof payload.runtime_settings === 'object'
              ? (payload.runtime_settings as Record<string, unknown>).auto_analysis
              : {},
          },
          chain_configs: [],
          ai_providers: [],
          ai_models: [],
          whitelist_patterns: [],
        });
        return true;
      }
      sendJson(res, 200, payload);
      return true;
    }

    if (reqPath === '/api/settings' && method === 'POST') {
      if (!requireAdmin()) return true;
      const body = await readJsonBody(req);
      const runtime = (typeof body.runtime_settings === 'object' && body.runtime_settings) ? body.runtime_settings as Record<string, unknown> : {};
      const patternSync = (typeof runtime.pattern_sync === 'object' && runtime.pattern_sync) ? runtime.pattern_sync as Record<string, unknown> : {};
      const aiAuditBackend = (typeof runtime.ai_audit_backend === 'object' && runtime.ai_audit_backend) ? runtime.ai_audit_backend as Record<string, unknown> : {};
      const access = (typeof runtime.access === 'object' && runtime.access) ? runtime.access as Record<string, unknown> : {};

      const chainConfigs = Array.isArray(body.chain_configs) ? body.chain_configs as Array<Record<string, unknown>> : [];
      const aiProviders = Array.isArray(body.ai_providers) ? body.ai_providers as Array<Record<string, unknown>> : [];
      const aiModelsRaw = Array.isArray(body.ai_models) ? body.ai_models as Array<Record<string, unknown>> : [];
      const whitelistPatterns = Array.isArray(body.whitelist_patterns) ? body.whitelist_patterns as Array<Record<string, unknown>> : [];

      const defaultAiProvider = getDefaultAiAuditProvider();
      const defaultAiModel = getDefaultAiAuditModel(defaultAiProvider);

      const normalizedProviders = aiProviders
        .map((row, index) => ({
          provider: String(row.provider || '').trim().toLowerCase(),
          enabled: coerceBoolean(row.enabled, true),
          position: coercePositiveInt(row.position, index),
        }))
        .filter((row) => row.provider === defaultAiProvider);

      const providerRows = normalizedProviders.length
        ? normalizedProviders
        : [{ provider: defaultAiProvider, enabled: true, position: 0 }];

      const normalizedModels = normalizeAiModelRows(
        providerRows,
        aiModelsRaw.map((row, index) => ({
          provider: String(row.provider || '').trim().toLowerCase(),
          model: String(row.model || '').trim(),
          enabled: coerceBoolean(row.enabled, true),
          isDefault: coerceBoolean(row.is_default ?? row.isDefault, false),
          position: coercePositiveInt(row.position, index),
        })),
      ).filter((row) => row.provider === defaultAiProvider);

      const modelRows = normalizedModels.length
        ? normalizedModels
        : [{
          provider: defaultAiProvider,
          model: defaultAiModel,
          enabled: true,
          isDefault: true,
          position: 0,
        }];

      const httpsEnabled = coerceBoolean(access.https_enabled, false);
      const tlsCertPath = String(access.tls_cert_path || '').trim();
      const tlsKeyPath = String(access.tls_key_path || '').trim();
      if (httpsEnabled && (!tlsCertPath || !tlsKeyPath)) {
        sendJson(res, 400, { error: 'TLS cert path and key path are required when HTTPS is enabled' });
        return true;
      }
      if (httpsEnabled) {
        try {
          await readFile(resolveProjectPath(tlsCertPath));
          await readFile(resolveProjectPath(tlsKeyPath));
        } catch (err) {
          sendJson(res, 400, { error: `TLS files could not be read: ${(err as Error).message}` });
          return true;
        }
      }

      const normalizedChainRows = chainConfigs
        .map((row) => {
          const nativeCurrency = (typeof row.native_currency === 'object' && row.native_currency)
            ? row.native_currency as Record<string, unknown>
            : {};
          return {
            chain: String(row.chain || '').trim().toLowerCase(),
            name: String(row.name || '').trim(),
            chainId: coercePositiveInt(row.chain_id ?? row.chainId, 0),
            tablePrefix: String((row.table_prefix ?? row.tablePrefix) || '').trim(),
            blocksPerScan: coercePositiveInt(row.blocks_per_scan ?? row.blocksPerScan, 75),
            chainbaseKeys: coerceStringArray(row.chainbase_keys ?? row.chainbaseKeys),
            rpcNetwork: String((row.rpc_network ?? row.rpcNetwork) || '').trim(),
            rpcUrls: [],
            multicall3Address: String(row.multicall3 || '').trim().toLowerCase(),
            wrappedNativeTokenAddress: String(
              row.wrapped_native_token_address
              ?? row.wrappedNativeTokenAddress
              ?? '',
            ).trim().toLowerCase(),
            nativeCurrencyName: String(
              row.native_currency_name
              ?? row.nativeCurrencyName
              ?? nativeCurrency.name
              ?? '',
            ).trim(),
            nativeCurrencySymbol: String(
              row.native_currency_symbol
              ?? row.nativeCurrencySymbol
              ?? nativeCurrency.symbol
              ?? '',
            ).trim(),
            nativeCurrencyDecimals: coercePositiveInt(
              row.native_currency_decimals
              ?? row.nativeCurrencyDecimals
              ?? nativeCurrency.decimals,
              18,
            ),
          };
        })
        .filter((row) => row.chain);
      const nextKnownChains = normalizedChainRows.map((row) => row.chain);

      if (!normalizedChainRows.length) {
        sendJson(res, 400, { error: 'At least one chain config is required' });
        return true;
      }
      const duplicateChains = nextKnownChains.filter((chain, index) => nextKnownChains.indexOf(chain) !== index);
      if (duplicateChains.length) {
        sendJson(res, 400, { error: `Duplicate chain config: ${duplicateChains[0]}` });
        return true;
      }
      for (const row of normalizedChainRows) {
        if (!/^[a-z0-9_-]+$/.test(row.chain)) {
          sendJson(res, 400, { error: `Invalid chain key: ${row.chain}` });
          return true;
        }
        if (!row.name || !row.tablePrefix || !row.chainId || !row.nativeCurrencyName || !row.nativeCurrencySymbol) {
          sendJson(res, 400, { error: `Incomplete chain config for ${row.chain}` });
          return true;
        }
        if (!row.rpcNetwork) {
          sendJson(res, 400, { error: `Chain ${row.chain} needs an Infura RPC network value` });
          return true;
        }
        if (row.wrappedNativeTokenAddress && !/^0x[a-f0-9]{40}$/i.test(row.wrappedNativeTokenAddress)) {
          sendJson(res, 400, { error: `Chain ${row.chain} has an invalid wrapped native token address` });
          return true;
        }
      }

      setManyAppSettings([
        { key: 'chainbase_keys', value: JSON.stringify(coerceStringArray(runtime.chainbase_keys)) },
        { key: 'rpc_keys', value: JSON.stringify(coerceStringArray(runtime.rpc_keys)) },
        { key: 'monitor_chains', value: JSON.stringify(coerceStringArray(runtime.monitored_chains).filter((chain) => nextKnownChains.includes(chain))) },
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
        { key: 'ai_audit_backend.base_url', value: String(aiAuditBackend.base_url || 'https://127.0.0.1:5000').trim() },
        { key: 'ai_audit_backend.api_key', value: String(aiAuditBackend.api_key || '').trim() },
        { key: 'ai_audit_backend.etherscan_api_key', value: String(aiAuditBackend.etherscan_api_key || '').trim() },
        { key: 'ai_audit_backend.poll_interval_ms', value: String(coercePositiveInt(aiAuditBackend.poll_interval_ms, 10_000)) },
        { key: 'ai_audit_backend.dedaub_wait_seconds', value: String(coercePositiveInt(aiAuditBackend.dedaub_wait_seconds, 15)) },
        { key: 'ai_audit_backend.insecure_tls', value: coerceBoolean(aiAuditBackend.insecure_tls, true) ? '1' : '0' },
        { key: 'web_security.https_enabled', value: httpsEnabled ? '1' : '0' },
        { key: 'web_security.tls_cert_path', value: tlsCertPath },
        { key: 'web_security.tls_key_path', value: tlsKeyPath },
      ]);

      replaceChainSettings(normalizedChainRows);

      replaceAiAuditProviders(providerRows);
      replaceAiAuditModels(modelRows);
      replaceWhitelistPatterns(whitelistPatterns.map((row, index) => ({
        name: String(row.name || '').trim(),
        hexPattern: String((row.hex_pattern ?? row.hexPattern) || '').trim(),
        patternType: String((row.pattern_type ?? row.patternType) || 'selector').trim().toLowerCase() || 'selector',
        score: Number.isFinite(Number(row.score)) ? Number(row.score) : (index + 1),
        description: String(row.description || '').trim(),
      })));
      reloadRuntimeConfig();
      await broadcastStateSnapshot();

      sendJson(res, 200, { ok: true, hot_applied: true, settings: await buildSettingsPayload(requestUsername) });
      return true;
    }

    return false;
  };
}

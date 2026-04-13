import type { IncomingMessage, ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import {
  getDefaultAiAuditModel,
  getDefaultAiAuditProvider,
  normalizeAiAuditModel,
  normalizeAiAuditProvider,
  reloadRuntimeConfig,
} from '../config.js';
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
  verifyPatterns,
} from '../modules/selectors-manager/index.js';
import {
  enqueueContractAiAudit,
  enqueueTokenAiAudit,
  getContractAiAuditPlan,
} from '../modules/ai-audit-runner/index.js';
import {
  getAutoAnalysisStatus,
  startAutoAnalysis,
  stopAutoAnalysis,
} from '../modules/auto-analysis/index.js';
import { withLiveReviews, type DashboardContractSummary, type DashboardTokenSummary, type LatestRunMeta } from '../modules/dashboard/read-model.js';
import { deriveAiAuditLifecycleStatus } from '../db/audit-state.js';
import type { PipelineRunResult } from '../pipeline.js';

type StateStreamClient = ServerResponse<IncomingMessage> & {
  __stateHeartbeat?: NodeJS.Timeout;
};

interface WebStateLike {
  running: boolean;
  runningChain: string | null;
}

interface ApiRouteHandlerDeps {
  chains: string[];
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
  buildStatePayload: () => Promise<unknown>;
  buildSettingsPayload: () => Promise<unknown>;
  buildAiAuditConfigPayload: () => unknown;
  broadcastStateSnapshot: () => Promise<void>;
  broadcastNamedEvent: (event: string, payload: unknown) => void;
  invalidateReadCaches: (chain?: string) => void;
  resolveRun: (chain: string) => PipelineRunResult | null;
  resolveDashboardContracts: (chain: string, run: PipelineRunResult) => DashboardContractSummary[];
  resolveDashboardTokens: (chain: string, run: PipelineRunResult) => DashboardTokenSummary[];
  resolveContractDetail: (chain: string, run: PipelineRunResult, contract: string) => unknown;
  latestRunMeta: (run: PipelineRunResult) => LatestRunMeta;
  handleRun: (chain: string) => Promise<PipelineRunResult>;
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

export function createApiRouteHandler(deps: ApiRouteHandlerDeps) {
  return async function handleApiRoute(
    req: IncomingMessage,
    res: ServerResponse,
    reqPath: string,
    method: string,
    url: URL,
  ): Promise<boolean> {
    const {
      chains,
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

    if (reqPath === '/api/state' && method === 'GET') {
      sendJson(res, 200, await buildStatePayload());
      return true;
    }

    if (reqPath === '/api/auto-analysis' && method === 'GET') {
      sendJson(res, 200, getAutoAnalysisStatus());
      return true;
    }

    if (reqPath === '/api/auto-analysis/start' && method === 'POST') {
      const body = await readJsonBody(req);
      const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
      if (!chain || !chains.includes(chain)) {
        sendJson(res, 400, { error: 'Unknown chain' });
        return true;
      }
      const status = startAutoAnalysis(chain);
      await broadcastStateSnapshot();
      sendJson(res, 200, { ok: true, status });
      return true;
    }

    if (reqPath === '/api/auto-analysis/stop' && method === 'POST') {
      const status = stopAutoAnalysis();
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
      return true;
    }

    if (reqPath === '/api/dashboard' && method === 'GET') {
      const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
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
      const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
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
      const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
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
      invalidateReadCaches();
      sendJson(res, 200, { ok: true, result, status: await getPatternSyncStatus() });
      return true;
    }

    if (reqPath === '/api/sync/push' && method === 'POST') {
      const result = await pushPatterns();
      invalidateReadCaches();
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
      const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
      const address = typeof body.address === 'string' ? body.address.toLowerCase() : '';
      const targetKind = typeof body.target_kind === 'string' ? body.target_kind.toLowerCase() : 'auto';
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if (!chain || !address || !label) {
        sendJson(res, 400, { error: 'chain, address, and label are required' });
        return true;
      }
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
      const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
      const address = typeof body.address === 'string' ? body.address.toLowerCase() : '';
      const targetKind = typeof body.target_kind === 'string' ? body.target_kind.toLowerCase() : 'auto';
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      const reviewText = typeof body.review_text === 'string' ? body.review_text.trim() : '';
      const exploitable = Boolean(body.exploitable);
      if (!chain || !address || !label) {
        sendJson(res, 400, { error: 'chain, address, and label are required' });
        return true;
      }
      const result = saveContractReview({ chain, address, targetKind, label, reviewText, exploitable });
      invalidateReadCaches(chain);
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
      const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
      const contract = typeof body.contract === 'string' ? body.contract.toLowerCase() : '';
      if (!chain || !contract) {
        sendJson(res, 400, { error: 'chain and contract are required' });
        return true;
      }
      const title = typeof body.title === 'string' ? body.title.trim() : 'AI Auto Audit';
      const provider = normalizeAiAuditProvider(typeof body.provider === 'string' ? body.provider.trim() : getDefaultAiAuditProvider());
      const model = normalizeAiAuditModel(provider, typeof body.model === 'string' ? body.model.trim() : getDefaultAiAuditModel(provider));
      const plan = getContractAiAuditPlan(chain, contract);
      if (!plan.accepted) {
        sendJson(res, 400, { error: plan.reason || 'Contract is not eligible for AI audit' });
        return true;
      }
      const analysis = requestContractAiAudit({ chain, contractAddr: contract, title, provider, model });
      enqueueContractAiAudit(analysis);
      invalidateReadCaches(chain);
      sendJson(res, 200, { ok: true, analysis, plan });
      return true;
    }

    if (reqPath === '/api/token-analysis/request' && method === 'POST') {
      const body = await readJsonBody(req);
      const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
      const token = typeof body.token === 'string' ? body.token.toLowerCase() : '';
      if (!chain || !token) {
        sendJson(res, 400, { error: 'chain and token are required' });
        return true;
      }
      const title = typeof body.title === 'string' ? body.title.trim() : 'AI Auto Audit';
      const provider = normalizeAiAuditProvider(typeof body.provider === 'string' ? body.provider.trim() : getDefaultAiAuditProvider());
      const model = normalizeAiAuditModel(provider, typeof body.model === 'string' ? body.model.trim() : getDefaultAiAuditModel(provider));
      const analysis = requestTokenAiAudit({ chain, tokenAddr: token, title, provider, model });
      enqueueTokenAiAudit(analysis);
      invalidateReadCaches(chain);
      sendJson(res, 200, { ok: true, analysis });
      return true;
    }

    if ((reqPath === '/api/contract-analysis/result' || reqPath === '/api/token-analysis/result') && method === 'POST') {
      const body = await readJsonBody(req);
      const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
      const isContract = reqPath.includes('/contract-');
      const targetKey = isContract ? 'contract' : 'token';
      const targetAddr = typeof body[targetKey] === 'string' ? String(body[targetKey]).toLowerCase() : '';
      if (!chain || !targetAddr) {
        sendJson(res, 400, { error: `chain and ${targetKey} are required` });
        return true;
      }
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
      invalidateReadCaches(chain);
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
      const chain = (url.searchParams.get('chain') ?? '').toLowerCase();
      const targetKey = isContract ? 'contract' : 'token';
      const targetAddr = (url.searchParams.get(targetKey) ?? '').toLowerCase();
      if (!chain || !targetAddr) {
        sendJson(res, 400, { error: `chain and ${targetKey} are required` });
        return true;
      }
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
      const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : chains[0];
      if (!chain || !chains.includes(chain)) {
        sendJson(res, 400, { error: 'Invalid chain' });
        return true;
      }
      if (state.running) {
        sendJson(res, 409, { error: 'Scan already running', running_chain: state.runningChain });
        return true;
      }
      const run = await handleRun(chain);
      sendJson(res, 200, { ok: true, run: latestRunMeta(run) });
      return true;
    }

    if (reqPath === '/api/results' && method === 'GET') {
      const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
      const run = resolveRun(chain);
      if (!run) {
        sendJson(res, 404, { error: 'No results for this chain yet' });
        return true;
      }
      sendJson(res, 200, { ...latestRunMeta(run), tokens: resolveDashboardTokens(chain, run) });
      return true;
    }

    if (reqPath === '/api/token' && method === 'GET') {
      const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
      const token = (url.searchParams.get('token') ?? '').toLowerCase();
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
      const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
      const token = typeof body.token === 'string' ? body.token.toLowerCase() : '';
      const reviewText = typeof body.review_text === 'string' ? body.review_text.trim() : '';
      const exploitable = Boolean(body.exploitable);
      if (!chain || !token) {
        sendJson(res, 400, { error: 'chain and token are required' });
        return true;
      }
      const saved = saveTokenManualReview({ chain, token, reviewText, exploitable });
      invalidateReadCaches(chain);
      sendJson(res, 200, { ok: true, token: saved });
      broadcastNamedEvent('review-updated', {
        kind: 'saved-token-review', chain, targetType: 'token', targetAddr: token, exploitable, ts: new Date().toISOString(),
      });
      return true;
    }

    if (reqPath === '/api/contract' && method === 'GET') {
      const chain = (url.searchParams.get('chain') ?? chains[0] ?? '').toLowerCase();
      const contract = (url.searchParams.get('contract') ?? '').toLowerCase();
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

    if (reqPath === '/api/settings' && method === 'GET') {
      sendJson(res, 200, await buildSettingsPayload());
      return true;
    }

    if (reqPath === '/api/settings' && method === 'POST') {
      const body = await readJsonBody(req);
      const runtime = (typeof body.runtime_settings === 'object' && body.runtime_settings) ? body.runtime_settings as Record<string, unknown> : {};
      const patternSync = (typeof runtime.pattern_sync === 'object' && runtime.pattern_sync) ? runtime.pattern_sync as Record<string, unknown> : {};
      const pancakePrice = (typeof runtime.pancakeswap_price === 'object' && runtime.pancakeswap_price) ? runtime.pancakeswap_price as Record<string, unknown> : {};
      const aiAuditBackend = (typeof runtime.ai_audit_backend === 'object' && runtime.ai_audit_backend) ? runtime.ai_audit_backend as Record<string, unknown> : {};
      const autoAnalysis = (typeof runtime.auto_analysis === 'object' && runtime.auto_analysis) ? runtime.auto_analysis as Record<string, unknown> : {};
      const access = (typeof runtime.access === 'object' && runtime.access) ? runtime.access as Record<string, unknown> : {};

      const chainConfigs = Array.isArray(body.chain_configs) ? body.chain_configs as Array<Record<string, unknown>> : [];
      const aiProviders = Array.isArray(body.ai_providers) ? body.ai_providers as Array<Record<string, unknown>> : [];
      const aiModelsRaw = Array.isArray(body.ai_models) ? body.ai_models as Array<Record<string, unknown>> : [];
      const whitelistPatterns = Array.isArray(body.whitelist_patterns) ? body.whitelist_patterns as Array<Record<string, unknown>> : [];

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
        { key: 'auto_analysis.provider', value: normalizeAiAuditProvider(String(autoAnalysis.provider || '').trim()) },
        { key: 'auto_analysis.model', value: normalizeAiAuditModel(normalizeAiAuditProvider(String(autoAnalysis.provider || '').trim()), String(autoAnalysis.model || '').trim()) },
        { key: 'auto_analysis.contract_min_tvl_usd', value: String(Number.isFinite(Number(autoAnalysis.contract_min_tvl_usd)) ? Number(autoAnalysis.contract_min_tvl_usd) : 10000) },
        { key: 'auto_analysis.token_min_price_usd', value: String(Number.isFinite(Number(autoAnalysis.token_min_price_usd)) ? Number(autoAnalysis.token_min_price_usd) : 0.001) },
        { key: 'auto_analysis.require_token_sync', value: coerceBoolean(autoAnalysis.require_token_sync, true) ? '1' : '0' },
        { key: 'auto_analysis.require_contract_selectors', value: coerceBoolean(autoAnalysis.require_contract_selectors, true) ? '1' : '0' },
        { key: 'auto_analysis.skip_seen_contracts', value: coerceBoolean(autoAnalysis.skip_seen_contracts, true) ? '1' : '0' },
        { key: 'auto_analysis.one_per_contract_pattern', value: coerceBoolean(autoAnalysis.one_per_contract_pattern, true) ? '1' : '0' },
        { key: 'auto_analysis.retry_failed_audits', value: coerceBoolean(autoAnalysis.retry_failed_audits, true) ? '1' : '0' },
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

      sendJson(res, 200, { ok: true, hot_applied: true, settings: await buildSettingsPayload() });
      return true;
    }

    return false;
  };
}

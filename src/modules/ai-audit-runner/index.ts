import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BaseAiAuditRow,
  type ContractRegistryRow,
  getContractsRegistry,
  listPendingAiAudits,
  reconcileTerminalAiAuditRows,
  saveContractAiAuditResult,
  saveTokenAiAuditResult,
  updateAiAuditBackendSessionIds,
  updateAiAuditLifecycleStatus,
} from '../../db.js';
import { getAiAuditBackendConfig } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { getAiAuditProviderModule, type ProviderAuditMode } from './providers/index.js';

const ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
const REPORT_DIR = path.join(ROOT, 'reports', 'ai-audits');
const MUCH_SMALLER_RATIO = 0.35;
const MUCH_SMALLER_ABS_DELTA = 300;
const VERIFICATION_RETRY_ATTEMPTS = 3;
const VERIFICATION_RETRY_BACKOFF_MS = 1_500;
const VERIFICATION_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_VERIFICATION_CACHE_ENTRIES = 512;
const AUDIT_START_STAGGER_MS = 400;

type QueuedAuditJob = BaseAiAuditRow;
type AuditMode = ProviderAuditMode;

interface ChainSpec {
  canonical: string;
  dedaubChain: string;
  etherscanChainId: string;
  explorerUrl: string;
  aliases: string[];
}

interface ContractAuditPlan {
  accepted: boolean;
  mode: AuditMode;
  reason: string | null;
  auditAddress: string;
  verificationAddress: string;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  insecureTls?: boolean;
  family?: 4 | 6;
}

interface ResponsePayload {
  statusCode: number;
  text: string;
}

interface VerificationStatus {
  verified: boolean;
  method: 'etherscan-api' | 'explorer-html';
  detail: string;
}

interface DedaubRequestResponse {
  session?: { id?: string };
  analysis?: { state?: string; error?: string; filePath?: string };
}

interface DedaubStatusResponse {
  session?: { id?: string; status?: string };
  analysis?: { state?: string; error?: string; filePath?: string };
}

interface AnalysisRequestResponse {
  session?: { id?: string };
  analysis?: { state?: string; error?: string };
}

interface AnalysisStatusResponse {
  session?: { id?: string; error?: string };
  analysis?: { state?: string; error?: string; result?: unknown };
}

interface ParsedAuditReport {
  generatedAt: string | null;
  markdownPath: string;
  jsonPath: string;
  critical: number;
  high: number;
  medium: number;
}

export interface AiAuditEvent {
  kind: 'queued' | 'started' | 'completed' | 'failed' | 'worker';
  chain: string;
  targetType: 'contract' | 'token';
  targetAddr: string;
  requestSession: string;
  title: string;
  provider: string;
  model: string;
  status: 'requested' | 'running' | 'completed' | 'failed';
  reportPath: string | null;
  critical: number | null;
  high: number | null;
  medium: number | null;
  error: string | null;
  queued: number;
  active: number;
  capacity: number;
  queuedContracts: number;
  queuedTokens: number;
  activeContracts: number;
  activeTokens: number;
  ts: string;
}

class HttpError extends Error {
  statusCode: number;
  body: string;

  constructor(message: string, statusCode: number, body: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

function describeAuditError(error: unknown): string {
  if (error instanceof HttpError) {
    const body = String(error.body || '').trim();
    return body ? `${error.message}: ${body}` : error.message;
  }
  if (error instanceof Error) {
    return error.message || error.toString();
  }
  return String(error);
}

const CHAIN_SPECS: ChainSpec[] = [
  { canonical: 'ethereum', dedaubChain: 'ethereum', etherscanChainId: '1', explorerUrl: 'https://etherscan.io', aliases: ['eth', 'ethereum', 'mainnet'] },
  { canonical: 'arbitrum', dedaubChain: 'arbitrum', etherscanChainId: '42161', explorerUrl: 'https://arbiscan.io', aliases: ['arb', 'arbitrum'] },
  { canonical: 'optimism', dedaubChain: 'optimism', etherscanChainId: '10', explorerUrl: 'https://optimistic.etherscan.io', aliases: ['op', 'optimism'] },
  { canonical: 'base', dedaubChain: 'base', etherscanChainId: '8453', explorerUrl: 'https://basescan.org', aliases: ['base'] },
  { canonical: 'polygon', dedaubChain: 'polygon', etherscanChainId: '137', explorerUrl: 'https://polygonscan.com', aliases: ['polygon', 'matic', 'poly'] },
  { canonical: 'bsc', dedaubChain: 'binance', etherscanChainId: '56', explorerUrl: 'https://bscscan.com', aliases: ['bsc', 'binance', 'binance-smart-chain', 'bnb'] },
  { canonical: 'avalanche', dedaubChain: 'avalanche', etherscanChainId: '43114', explorerUrl: 'https://snowtrace.io', aliases: ['avalanche', 'avax'] },
  { canonical: 'blast', dedaubChain: 'blast', etherscanChainId: '81457', explorerUrl: 'https://blastscan.io', aliases: ['blast'] },
];

const CHAIN_BY_ALIAS = new Map<string, ChainSpec>();
for (const spec of CHAIN_SPECS) {
  CHAIN_BY_ALIAS.set(spec.canonical, spec);
  for (const alias of spec.aliases) CHAIN_BY_ALIAS.set(alias, spec);
}

let workerStarted = false;
let maxConcurrentAudits = 10;
const queuedSessions = new Set<string>();
const activeSessions = new Set<string>();
const activeJobTypes = new Map<string, 'contract' | 'token'>();
const queue: QueuedAuditJob[] = [];
const aiAuditListeners = new Set<(event: AiAuditEvent) => void | Promise<void>>();
const verificationStatusCache = new Map<string, { expiresAt: number; status: VerificationStatus }>();
let drainLoopRunning = false;
let nextAuditStartAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verificationCacheKey(chain: string, address: string): string {
  return `${String(chain || '').toLowerCase()}:${normalizeAddress(address)}`;
}

function getCachedVerificationStatus(chain: string, address: string): VerificationStatus | null {
  const key = verificationCacheKey(chain, address);
  const cached = verificationStatusCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    verificationStatusCache.delete(key);
    return null;
  }
  return cached.status;
}

function setCachedVerificationStatus(chain: string, address: string, status: VerificationStatus): VerificationStatus {
  const key = verificationCacheKey(chain, address);
  if (verificationStatusCache.has(key)) verificationStatusCache.delete(key);
  verificationStatusCache.set(key, {
    expiresAt: Date.now() + VERIFICATION_CACHE_TTL_MS,
    status,
  });
  while (verificationStatusCache.size > MAX_VERIFICATION_CACHE_ENTRIES) {
    const oldestKey = verificationStatusCache.keys().next().value;
    if (oldestKey == null) break;
    verificationStatusCache.delete(oldestKey);
  }
  return status;
}

async function retryVerificationProbe<T>(
  label: string,
  request: () => Promise<T>,
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= VERIFICATION_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error as Error;
      const finalAttempt = attempt >= VERIFICATION_RETRY_ATTEMPTS;
      logger.warn(
        `[ai-audit] ${label} failed (attempt ${attempt}/${VERIFICATION_RETRY_ATTEMPTS}): ${lastError.message}`,
      );
      if (!finalAttempt) {
        await sleep(VERIFICATION_RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastError ?? new Error(`${label} failed`);
}

function publishAiAuditEvent(job: QueuedAuditJob, patch: {
  kind: AiAuditEvent['kind'];
  status: AiAuditEvent['status'];
  reportPath?: string | null;
  critical?: number | null;
  high?: number | null;
  medium?: number | null;
  error?: string | null;
}): void {
  const worker = getAiAuditWorkerStatus();
  const event: AiAuditEvent = {
    kind: patch.kind,
    chain: job.chain,
    targetType: job.targetType,
    targetAddr: job.targetAddr,
    requestSession: job.requestSession,
    title: job.title,
    provider: job.provider,
    model: job.model,
    status: patch.status,
    reportPath: patch.reportPath ?? null,
    critical: patch.critical ?? null,
    high: patch.high ?? null,
    medium: patch.medium ?? null,
    error: patch.error ?? null,
    queued: worker.queued,
    active: worker.active,
    capacity: worker.capacity,
    queuedContracts: worker.queuedContracts,
    queuedTokens: worker.queuedTokens,
    activeContracts: worker.activeContracts,
    activeTokens: worker.activeTokens,
    ts: new Date().toISOString(),
  };

  for (const listener of aiAuditListeners) {
    try {
      void listener(event);
    } catch {
      // no-op
    }
  }
}

function requestText(rawUrl: string, options: RequestOptions = {}): Promise<ResponsePayload> {
  const url = new URL(rawUrl);
  const transport = url.protocol === 'https:' ? https : http;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const method = options.method ?? 'GET';
  const body = options.body ?? '';
  const headers: Record<string, string> = {
    'user-agent': 'event-filter-ai-audit/1.0',
    accept: '*/*',
    ...(options.headers ?? {}),
  };

  if (body && !headers['content-length'] && !headers['Content-Length']) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }

  return new Promise<ResponsePayload>((resolve, reject) => {
    const req = transport.request(url, {
      method,
      headers,
      rejectUnauthorized: url.protocol === 'https:' ? !Boolean(options.insecureTls) : undefined,
      family: options.family,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        resolve({
          statusCode: Number(res.statusCode || 0),
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson<T>(rawUrl: string, options: RequestOptions = {}): Promise<T> {
  const response = await requestText(rawUrl, options);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new HttpError(`request failed with status ${response.statusCode}`, response.statusCode, response.text);
  }
  return JSON.parse(response.text) as T;
}

function getChainSpec(chain: string): ChainSpec {
  const spec = CHAIN_BY_ALIAS.get(String(chain || '').trim().toLowerCase());
  if (!spec) {
    throw new Error(`unsupported chain for AI audit: ${chain}`);
  }
  return spec;
}

function normalizeAddress(address: string): string {
  return String(address || '').trim().toLowerCase();
}

function hasSelectors(registry: ContractRegistryRow | undefined): boolean {
  return Boolean(registry?.selectors?.length);
}

function isLikelyAddress(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^0x[a-f0-9]{40}$/i.test(value.trim());
}

function isMuchSmaller(smaller: number, larger: number): boolean {
  if (!Number.isFinite(smaller) || !Number.isFinite(larger)) return false;
  if (smaller <= 0 || larger <= 0) return false;
  return smaller <= larger * MUCH_SMALLER_RATIO && (larger - smaller) >= MUCH_SMALLER_ABS_DELTA;
}

export function getContractAiAuditPlan(chain: string, contractAddr: string): ContractAuditPlan {
  const target = normalizeAddress(contractAddr);
  const registry = getContractsRegistry(chain, [target]).get(target);
  if (!registry) {
    return {
      accepted: false,
      mode: 'single',
      reason: 'Contract metadata not found',
      auditAddress: target,
      verificationAddress: target,
    };
  }

  const linkage = isLikelyAddress(registry.linkage) ? normalizeAddress(registry.linkage) : null;
  if (!linkage || !registry.linkType) {
    if (!hasSelectors(registry)) {
      return {
        accepted: false,
        mode: 'single',
        reason: 'Single-address audit requires selectors',
        auditAddress: target,
        verificationAddress: target,
      };
    }
    return {
      accepted: true,
      mode: 'single',
      reason: null,
      auditAddress: target,
      verificationAddress: target,
    };
  }

  const linkedRegistry = getContractsRegistry(chain, [linkage]).get(linkage);
  const selfSize = registry.codeSize ?? 0;
  const linkedSize = linkedRegistry?.codeSize ?? 0;

  if (!linkedRegistry) {
    if (registry.linkType === 'proxy') {
      return {
        accepted: true,
        mode: 'proxy',
        reason: null,
        auditAddress: target,
        verificationAddress: linkage,
      };
    }

    if (!hasSelectors(registry)) {
      return {
        accepted: false,
        mode: 'single',
        reason: 'Linked contract metadata is missing and the target has no selectors',
        auditAddress: target,
        verificationAddress: target,
      };
    }

    return {
      accepted: true,
      mode: 'single',
      reason: null,
      auditAddress: target,
      verificationAddress: target,
    };
  }

  if (isMuchSmaller(selfSize, linkedSize)) {
    return {
      accepted: true,
      mode: 'proxy',
      reason: null,
      auditAddress: target,
      verificationAddress: linkage,
    };
  }

  if (isMuchSmaller(linkedSize, selfSize)) {
    if (!hasSelectors(registry)) {
      return {
        accepted: false,
        mode: 'single',
        reason: 'Linked implementation looks too small and the target has no selectors',
        auditAddress: target,
        verificationAddress: target,
      };
    }
    return {
      accepted: true,
      mode: 'single',
      reason: null,
      auditAddress: target,
      verificationAddress: target,
    };
  }

  if (!hasSelectors(registry)) {
    return {
      accepted: false,
      mode: 'single',
      reason: 'Comparable bytecode sizes require single-address audit, but selectors are missing',
      auditAddress: target,
      verificationAddress: target,
    };
  }

  return {
    accepted: true,
    mode: 'single',
    reason: null,
    auditAddress: target,
    verificationAddress: target,
  };
}

function getAuthHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };
}

async function postJson<T>(baseUrl: string, apiKey: string, insecureTls: boolean, endpoint: string, body: Record<string, unknown>): Promise<T> {
  return await requestJson<T>(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: getAuthHeaders(apiKey),
    body: JSON.stringify(body),
    insecureTls,
  });
}

async function resolveVerificationStatus(
  baseUrlConfig: ReturnType<typeof getAiAuditBackendConfig>,
  chain: ChainSpec,
  verificationAddress: string,
): Promise<VerificationStatus> {
  const cached = getCachedVerificationStatus(chain.canonical, verificationAddress);
  if (cached) return cached;

  let etherscanErrorMessage = '';
  if (baseUrlConfig.etherscanApiKey) {
    const url = new URL('https://api.etherscan.io/v2/api');
    url.searchParams.set('module', 'contract');
    url.searchParams.set('action', 'getsourcecode');
    url.searchParams.set('chainid', chain.etherscanChainId);
    url.searchParams.set('address', verificationAddress);
    url.searchParams.set('apikey', baseUrlConfig.etherscanApiKey);

    try {
      const response = await retryVerificationProbe(
        `Etherscan verification for ${chain.canonical}:${verificationAddress}`,
        async () => await requestJson<{
        result?: Array<{ SourceCode?: string; ABI?: string }> | string;
      }>(url.toString(), { family: 4 }),
      );

      if (Array.isArray(response.result) && response.result.length > 0) {
        const record = response.result[0] ?? {};
        const sourceCode = String(record.SourceCode || '').trim();
        const abi = String(record.ABI || '').trim();
        const verified =
          Boolean(sourceCode) &&
          abi !== 'Contract source code not verified' &&
          !sourceCode.includes('Contract source code not verified');
        return setCachedVerificationStatus(chain.canonical, verificationAddress, {
          verified,
          method: 'etherscan-api',
          detail: verified ? 'verified source returned by Etherscan API' : 'Etherscan API indicates source is not verified',
        });
      }
      if (typeof response.result === 'string' && response.result.trim()) {
        etherscanErrorMessage = `Etherscan API result: ${response.result.trim()}`;
      }
    } catch (error) {
      etherscanErrorMessage = (error as Error).message || 'unknown error';
    }
  }

  const explorerUrl = `${chain.explorerUrl}/address/${verificationAddress}#code`;
  try {
    const html = await retryVerificationProbe(
      `Explorer verification for ${chain.canonical}:${verificationAddress}`,
      async () => await requestText(explorerUrl, { timeoutMs: 30_000, family: 4 }),
    );
    const verified =
      html.text.includes('Source Code Verified')
      || html.text.includes('Contract Source Code Verified')
      || html.text.includes('Similar Match Source Code')
      || html.text.includes('Contract: Verified');
    const similarMatch = html.text.includes('Similar Match Source Code');
    return setCachedVerificationStatus(chain.canonical, verificationAddress, {
      verified,
      method: 'explorer-html',
      detail: verified
        ? (similarMatch
          ? `similar-match verified marker found at ${explorerUrl}`
          : `verified marker found at ${explorerUrl}`)
        : `verified marker not found at ${explorerUrl}`,
    });
  } catch (error) {
    const explorerErrorMessage = (error as Error).message || 'unknown error';
    return setCachedVerificationStatus(chain.canonical, verificationAddress, {
      verified: false,
      method: 'explorer-html',
      detail: etherscanErrorMessage
        ? `verification probes failed; etherscan: ${etherscanErrorMessage}; explorer: ${explorerErrorMessage}`
        : `verification probe failed at ${explorerUrl}: ${explorerErrorMessage}`,
    });
  }
}

async function waitForDedaubFile(
  backend: ReturnType<typeof getAiAuditBackendConfig>,
  chain: ChainSpec,
  address: string,
): Promise<{ jobId: string; filePath: string }> {
  const startResponse = await postJson<DedaubRequestResponse>(
    backend.baseUrl,
    backend.apiKey,
    backend.insecureTls,
    '/api/dedaub/request',
    {
      chain: chain.dedaubChain,
      address,
      waitSeconds: backend.dedaubWaitSeconds,
    },
  );

  const jobId = String(startResponse.session?.id || '').trim();
  if (!jobId) {
    throw new Error('Dedaub request did not return a session id');
  }

  const filePath = await waitForDedaubFileByJobId(backend, jobId);
  return { jobId, filePath };
}

async function waitForDedaubFileByJobId(
  backend: ReturnType<typeof getAiAuditBackendConfig>,
  jobId: string,
): Promise<string> {
  while (true) {
    await sleep(backend.pollIntervalMs);
    const status = await postJson<DedaubStatusResponse>(
      backend.baseUrl,
      backend.apiKey,
      backend.insecureTls,
      '/api/dedaub/status',
      { sessionId: jobId },
    );

    const state = String(status.analysis?.state || '').trim().toLowerCase();
    if (state === 'completed') {
      const filePath = String(status.analysis?.filePath || '').trim();
      if (!filePath) throw new Error('Dedaub completed without filePath');
      return filePath;
    }
    if (state === 'stopped') {
      throw new Error(`Dedaub failed: ${String(status.analysis?.error || 'unknown error')}`);
    }
  }
}

async function startAnalysis(
  backend: ReturnType<typeof getAiAuditBackendConfig>,
  job: QueuedAuditJob,
  chain: ChainSpec,
  prompt: string,
  sourceCodePath: string,
  auditAddress: string,
): Promise<AnalysisRequestResponse> {
  return await postJson<AnalysisRequestResponse>(
    backend.baseUrl,
    backend.apiKey,
    backend.insecureTls,
    '/api/analysis/request',
    {
      provider: job.provider,
      model: job.model,
      title: job.title,
      prompt,
      sourceCodePath: sourceCodePath || undefined,
      contractAddress: auditAddress,
      chain: chain.canonical,
    },
  );
}

async function waitForAnalysisResult(
  backend: ReturnType<typeof getAiAuditBackendConfig>,
  sessionId: string,
): Promise<AnalysisStatusResponse> {
  while (true) {
    await sleep(backend.pollIntervalMs);
    const status = await postJson<AnalysisStatusResponse>(
      backend.baseUrl,
      backend.apiKey,
      backend.insecureTls,
      '/api/analysis/status',
      { sessionId },
    );

    const state = String(status.analysis?.state || '').trim().toLowerCase();
    if (state === 'completed') return status;
    if (state === 'stopped') {
      throw new Error(`analysis stopped: ${String(status.analysis?.error || status.session?.error || 'unknown error')}`);
    }
  }
}

function renderResult(result: unknown): string {
  if (typeof result === 'string') return result.trim() || '(empty result)';
  return JSON.stringify(result, null, 2);
}

function extractSeverityCounts(result: unknown): { critical: number; high: number; medium: number } {
  const text = renderResult(result);
  const normalizedText = text.replace(/[*_`]/g, '');
  const counts = { critical: 0, high: 0, medium: 0 };
  for (const match of normalizedText.matchAll(/Severity\s*:\s*(CRITICAL|HIGH|MEDIUM)\b/gi)) {
    const severity = String(match[1] || '').toLowerCase();
    if (severity === 'critical') counts.critical += 1;
    if (severity === 'high') counts.high += 1;
    if (severity === 'medium') counts.medium += 1;
  }
  return counts;
}

async function writeAuditReport(
  job: QueuedAuditJob,
  chain: ChainSpec,
  mode: AuditMode,
  auditAddress: string,
  verificationAddress: string,
  prompt: string,
  sourceCodePath: string,
  verification: VerificationStatus,
  dedaubJobId: string,
  analysisSessionId: string,
  analysisStatus: AnalysisStatusResponse,
): Promise<ParsedAuditReport> {
  await mkdir(REPORT_DIR, { recursive: true });
  const stem = `${chain.canonical}_${auditAddress}`.toLowerCase();
  const markdownPath = path.join(REPORT_DIR, `${stem}.md`);
  const jsonPath = path.join(REPORT_DIR, `${stem}.json`);
  const generatedAt = new Date().toISOString();
  const resultText = renderResult(analysisStatus.analysis?.result);

  const markdown = `# Audit Report

- generatedAt: ${generatedAt}
- chain: ${chain.canonical}
- mode: ${mode}
- auditAddress: ${auditAddress}
- verificationAddress: ${verificationAddress}
- provider: ${job.provider}
- model: ${job.model}
- verificationStatus: ${verification.verified ? 'verified' : 'unverified'}
- verificationMethod: ${verification.method}
- verificationDetail: ${verification.detail}
- dedaubJobId: ${dedaubJobId || 'n/a'}
- analysisSessionId: ${analysisSessionId}
- sourceCodePath: ${sourceCodePath || 'n/a'}
- prompt: ${prompt}

## Result

${resultText}
`;

  const metadata = {
    generatedAt,
    chain: chain.canonical,
    mode,
    auditAddress,
    verificationAddress,
    provider: job.provider,
    model: job.model,
    prompt,
    sourceCodePath,
    verification,
    dedaubJobId,
    analysisSessionId,
    analysis: analysisStatus,
  };

  await writeFile(markdownPath, markdown, 'utf8');
  await writeFile(jsonPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  const severity = extractSeverityCounts(analysisStatus.analysis?.result);
  return {
    generatedAt,
    markdownPath,
    jsonPath,
    critical: severity.critical,
    high: severity.high,
    medium: severity.medium,
  };
}

function persistFailure(
  job: QueuedAuditJob,
  sessions: { dedaubJobId?: string | null; analysisSessionId?: string | null } = {},
  errorMessage?: string | null,
): void {
  const payload = {
    chain: job.chain,
    requestSession: job.requestSession,
    title: job.title,
    provider: job.provider,
    model: job.model,
    dedaubJobId: sessions.dedaubJobId ?? job.dedaubJobId ?? null,
    analysisSessionId: sessions.analysisSessionId ?? job.analysisSessionId ?? null,
    resultPath: null,
    critical: null,
    high: null,
    medium: null,
    isSuccess: false,
    auditedAt: new Date().toISOString(),
  };

  if (job.targetType === 'contract') {
    saveContractAiAuditResult({ ...payload, contractAddr: job.targetAddr });
  } else {
    saveTokenAiAuditResult({ ...payload, tokenAddr: job.targetAddr });
  }

  publishAiAuditEvent(job, {
    kind: 'failed',
    status: 'failed',
    error: String(errorMessage || '').trim() || 'audit failed',
  });
}

function persistSuccess(
  job: QueuedAuditJob,
  report: ParsedAuditReport,
  sessions: { dedaubJobId?: string | null; analysisSessionId?: string | null } = {},
): void {
  const payload = {
    chain: job.chain,
    requestSession: job.requestSession,
    title: job.title,
    provider: job.provider,
    model: job.model,
    dedaubJobId: sessions.dedaubJobId ?? job.dedaubJobId ?? null,
    analysisSessionId: sessions.analysisSessionId ?? job.analysisSessionId ?? null,
    resultPath: path.relative(ROOT, report.markdownPath).split(path.sep).join('/'),
    critical: report.critical,
    high: report.high,
    medium: report.medium,
    isSuccess: true,
    auditedAt: report.generatedAt ?? new Date().toISOString(),
  };

  if (job.targetType === 'contract') {
    saveContractAiAuditResult({ ...payload, contractAddr: job.targetAddr });
  } else {
    saveTokenAiAuditResult({ ...payload, tokenAddr: job.targetAddr });
  }

  publishAiAuditEvent(job, {
    kind: 'completed',
    status: 'completed',
    reportPath: payload.resultPath,
    critical: report.critical,
    high: report.high,
    medium: report.medium,
  });
}

function resolveExecutionContext(job: QueuedAuditJob): {
  backend: ReturnType<typeof getAiAuditBackendConfig>;
  chain: ChainSpec;
  providerModule: NonNullable<ReturnType<typeof getAiAuditProviderModule>>;
  mode: AuditMode;
  auditAddress: string;
  verificationAddress: string;
} {
  const backend = getAiAuditBackendConfig();
  const chain = getChainSpec(job.chain);
  const providerModule = getAiAuditProviderModule(job.provider);
  if (!providerModule) {
    throw new Error(`Unsupported provider module for ${job.provider}`);
  }

  let mode: AuditMode = 'single';
  let auditAddress = job.targetAddr;
  let verificationAddress = job.targetAddr;
  if (job.targetType === 'contract') {
    const plan = getContractAiAuditPlan(job.chain, job.targetAddr);
    if (!plan.accepted) {
      throw new Error(plan.reason || 'Contract is not requestable');
    }
    mode = plan.mode;
    auditAddress = plan.auditAddress;
    verificationAddress = plan.verificationAddress;
  }

  return {
    backend,
    chain,
    providerModule,
    mode,
    auditAddress,
    verificationAddress,
  };
}

async function continueAuditJob(
  job: QueuedAuditJob,
  options: {
    reason: 'fresh' | 'resume';
  },
): Promise<void> {
  let dedaubJobId = String(job.dedaubJobId || '').trim();
  let analysisSessionId = String(job.analysisSessionId || '').trim();

  try {
    const { backend, chain, providerModule, mode, auditAddress, verificationAddress } = resolveExecutionContext(job);
    if (!backend.baseUrl || !backend.apiKey) {
      throw new Error('backend config is incomplete');
    }

    if (options.reason === 'fresh') {
      logger.info(`[ai-audit] Starting ${job.targetType} audit ${job.chain}:${job.targetAddr} (${mode}) via ${job.provider}/${job.model}`);
    } else {
      logger.info(`[ai-audit] Resuming ${job.targetType} audit ${job.chain}:${job.targetAddr} (${mode}) via ${job.provider}/${job.model}`);
    }

    updateAiAuditLifecycleStatus({
      requestSession: job.requestSession,
      status: 'running',
    });
    publishAiAuditEvent(job, {
      kind: 'started',
      status: 'running',
    });

    const verification = await resolveVerificationStatus(backend, chain, verificationAddress);
    let sourceCodePath = '';
    if (!verification.verified) {
      if (dedaubJobId) {
        sourceCodePath = await waitForDedaubFileByJobId(backend, dedaubJobId);
      } else {
        const decompile = await waitForDedaubFile(backend, chain, verificationAddress);
        dedaubJobId = decompile.jobId;
        sourceCodePath = decompile.filePath;
        updateAiAuditBackendSessionIds({
          requestSession: job.requestSession,
          dedaubJobId,
        });
      }
    }

    const prompt = providerModule.buildPrompt({
      mode,
      chain: chain.canonical,
      auditAddress,
      verified: verification.verified,
      sourceCodePath,
    });

    if (!analysisSessionId) {
      const analysisStart = await startAnalysis(backend, job, chain, prompt, sourceCodePath, auditAddress);
      analysisSessionId = String(analysisStart.session?.id || '').trim();
      if (!analysisSessionId) {
        throw new Error('analysis request did not return a session id');
      }
      updateAiAuditBackendSessionIds({
        requestSession: job.requestSession,
        analysisSessionId,
      });
    }

    const analysisStatus = await waitForAnalysisResult(backend, analysisSessionId);
    const report = await writeAuditReport(
      job,
      chain,
      mode,
      auditAddress,
      verificationAddress,
      prompt,
      sourceCodePath,
      verification,
      dedaubJobId,
      analysisSessionId,
      analysisStatus,
    );
    persistSuccess(job, report, { dedaubJobId, analysisSessionId });
    logger.info(`[ai-audit] Completed ${job.targetType} audit ${job.chain}:${job.targetAddr} -> c:${report.critical} h:${report.high} m:${report.medium}`);
  } catch (error) {
    logger.error(`[ai-audit] Audit failed for ${job.targetType} ${job.chain}:${job.targetAddr}`, error);
    persistFailure(job, { dedaubJobId, analysisSessionId }, describeAuditError(error));
  }
}

async function executeAuditJob(job: QueuedAuditJob): Promise<void> {
  try {
    await continueAuditJob(job, { reason: 'fresh' });
  } catch (error) {
    logger.error(`[ai-audit] Audit failed for ${job.targetType} ${job.chain}:${job.targetAddr}`, error);
    persistFailure(job, {
      dedaubJobId: job.dedaubJobId ?? null,
      analysisSessionId: job.analysisSessionId ?? null,
    }, describeAuditError(error));
  }
}

async function drainQueue(): Promise<void> {
  if (drainLoopRunning) return;
  drainLoopRunning = true;
  try {
    while (queue.length && activeSessions.size < maxConcurrentAudits) {
      const waitMs = Math.max(0, nextAuditStartAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      const job = queue.shift();
      if (!job) continue;
      queuedSessions.delete(job.requestSession);
      if (activeSessions.has(job.requestSession)) continue;

      nextAuditStartAt = Date.now() + AUDIT_START_STAGGER_MS;
      activeSessions.add(job.requestSession);
      activeJobTypes.set(job.requestSession, job.targetType);
      void (async () => {
        try {
          await executeAuditJob(job);
        } finally {
          activeSessions.delete(job.requestSession);
          activeJobTypes.delete(job.requestSession);
          void drainQueue();
        }
      })();
    }
  } finally {
    drainLoopRunning = false;
    if (queue.length && activeSessions.size < maxConcurrentAudits) {
      void drainQueue();
    }
  }
}

function enqueueAudit(job: QueuedAuditJob | null | undefined): void {
  if (!job?.requestSession) return;
  if (queuedSessions.has(job.requestSession) || activeSessions.has(job.requestSession)) return;
  queuedSessions.add(job.requestSession);
  queue.push(job);
  publishAiAuditEvent(job, {
    kind: 'queued',
    status: 'requested',
  });
  void drainQueue();
}

function resumeAudit(job: QueuedAuditJob): void {
  if (!job?.requestSession) return;
  if (queuedSessions.has(job.requestSession) || activeSessions.has(job.requestSession)) return;
  activeSessions.add(job.requestSession);
  activeJobTypes.set(job.requestSession, job.targetType);
  void (async () => {
    try {
      await continueAuditJob(job, { reason: 'resume' });
    } finally {
      activeSessions.delete(job.requestSession);
      activeJobTypes.delete(job.requestSession);
      void drainQueue();
    }
  })();
}

export function startAiAuditWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const repaired = reconcileTerminalAiAuditRows();
  if (repaired > 0) {
    logger.warn(`[ai-audit] Reconciled ${repaired} stale terminal audit row(s) before worker startup`);
  }
  const pending = listPendingAiAudits();
  if (pending.length) {
    logger.info(`[ai-audit] Restoring ${pending.length} pending audit request(s)`);
  }
  for (const job of pending) {
    if (job.status === 'requested' && !job.dedaubJobId && !job.analysisSessionId) {
      enqueueAudit(job);
      continue;
    }
    if (job.analysisSessionId || job.dedaubJobId) {
      resumeAudit(job);
      continue;
    }
    logger.warn(
      `[ai-audit] Marking ${job.targetType} ${job.chain}:${job.targetAddr} session=${job.requestSession} as failed; backend session ids were not persisted`,
    );
    persistFailure(job, {}, 'backend session ids were not persisted');
  }
}

export function getAiAuditWorkerStatus(): {
  queued: number;
  active: number;
  capacity: number;
  queuedContracts: number;
  queuedTokens: number;
  activeContracts: number;
  activeTokens: number;
} {
  const queuedContracts = queue.filter((job) => job.targetType === 'contract').length;
  const queuedTokens = queue.filter((job) => job.targetType === 'token').length;
  let activeContracts = 0;
  let activeTokens = 0;
  for (const type of activeJobTypes.values()) {
    if (type === 'contract') activeContracts += 1;
    if (type === 'token') activeTokens += 1;
  }
  return {
    queued: queue.length,
    active: activeSessions.size,
    capacity: maxConcurrentAudits,
    queuedContracts,
    queuedTokens,
    activeContracts,
    activeTokens,
  };
}

export function setAiAuditWorkerCapacity(nextCapacity: number): void {
  const normalized = Number.isFinite(nextCapacity) && nextCapacity > 0
    ? Math.max(1, Math.floor(nextCapacity))
    : 10;
  maxConcurrentAudits = normalized;
  void drainQueue();
}

export function subscribeAiAuditEvents(
  listener: (event: AiAuditEvent) => void | Promise<void>,
): () => void {
  aiAuditListeners.add(listener);
  return () => {
    aiAuditListeners.delete(listener);
  };
}

export function enqueueContractAiAudit(row: BaseAiAuditRow | null | undefined): void {
  if (!row || row.targetType !== 'contract') return;
  enqueueAudit(row);
}

export function enqueueTokenAiAudit(row: BaseAiAuditRow | null | undefined): void {
  if (!row || row.targetType !== 'token') return;
  enqueueAudit(row);
}

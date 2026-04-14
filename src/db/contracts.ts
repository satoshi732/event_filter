import { getDb, v2Id } from './core.js';
import { AiAuditTargetType, BaseAiAuditRow, ContractAiAuditRow, ContractRegistryRow, TokenAiAuditRow } from './types.js';
import {
  getDefaultAiAuditModel,
  getDefaultAiAuditProvider,
  normalizeAiAuditModel,
  normalizeAiAuditProvider,
} from '../config.js';
import { deriveAiAuditLifecycleStatus, normalizeAiAuditLifecycleStatus } from './audit-state.js';
import { logger } from '../utils/logger.js';

export function getKnownContractAddresses(chain: string): Set<string> {
  const rows = getDb().prepare(`
    SELECT contract_addr
    FROM contracts_registry
    WHERE chain = ?
  `).all(chain.toLowerCase()) as Array<{ contract_addr: string }>;
  return new Set(rows.map((row) => row.contract_addr.toLowerCase()));
}

export function getContractsRegistry(
  chain: string,
  addresses: string[],
): Map<string, ContractRegistryRow> {
  const normalized = [...new Set(addresses.map((value) => value.toLowerCase()).filter(Boolean))];
  if (!normalized.length) return new Map();
  const placeholders = normalized.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT
      id, contract_addr, chain, linkage, link_type, label, review,
      contract_selector_hash, contract_selectors, contract_code_size, selector_hash,
      is_exploitable, portfolio, is_auto_audit, is_manual_audit, whitelist_patterns, selectors, code_size,
      deployed_at
    FROM contracts_registry
    WHERE chain = ?
      AND contract_addr IN (${placeholders})
  `).all(chain.toLowerCase(), ...normalized) as Array<{
    id: string;
    contract_addr: string;
    chain: string;
    deployed_at: string | null;
    linkage: string | null;
    link_type: 'proxy' | 'eip7702' | null;
    label: string;
    review: string;
    contract_selector_hash: string | null;
    contract_selectors: string;
    contract_code_size: number;
    selector_hash: string | null;
    is_exploitable: number;
    portfolio: string;
    is_auto_audit: number;
    is_manual_audit: number;
    whitelist_patterns: string;
    selectors: string;
    code_size: number;
  }>;

  return new Map(rows.map((row) => [
    row.contract_addr.toLowerCase(),
    {
      id: row.id,
      contractAddr: row.contract_addr.toLowerCase(),
      chain: row.chain,
      deployedAt: row.deployed_at ?? null,
      linkage: row.linkage,
      linkType: row.link_type,
      label: row.label ?? '',
      review: row.review ?? '',
      contractSelectorHash: row.contract_selector_hash,
      contractSelectors: (row.contract_selectors ?? '').split(',').map((value) => value.trim()).filter(Boolean),
      contractCodeSize: row.contract_code_size ?? 0,
      selectorHash: row.selector_hash,
      isExploitable: Boolean(row.is_exploitable),
      portfolio: row.portfolio ?? '{}',
      isAutoAudit: Boolean(row.is_auto_audit),
      isManualAudit: Boolean(row.is_manual_audit),
      whitelistPatterns: (row.whitelist_patterns ?? '').split(',').map((value) => value.trim()).filter(Boolean),
      selectors: (row.selectors ?? '').split(',').map((value) => value.trim()).filter(Boolean),
      codeSize: row.code_size ?? 0,
    },
  ]));
}

export function upsertContractsRegistryBatch(
  chain: string,
  rows: Array<{
    contractAddr: string;
    linkage: string | null;
    linkType: 'proxy' | 'eip7702' | null;
    label: string;
    review?: string;
    contractSelectorHash?: string | null;
    contractSelectors?: string[];
    contractCodeSize?: number;
    selectorHash: string | null;
    isExploitable: boolean;
    portfolio: string;
    deployedAt?: string | null;
    isAutoAudit?: boolean;
    isManualAudit?: boolean;
    whitelistPatterns: string[];
    selectors: string[];
    codeSize: number;
  }>,
): void {
  if (!rows.length) return;
  const chainName = chain.toLowerCase();
  const insert = getDb().prepare(`
    INSERT INTO contracts_registry (
      id, contract_addr, chain, linkage, link_type, label, review,
      contract_selector_hash, contract_selectors, contract_code_size, selector_hash,
      is_exploitable, portfolio, is_auto_audit, is_manual_audit, whitelist_patterns, selectors,
      code_size, deployed_at, created_at, updated_at
    ) VALUES (
      @id, @contract_addr, @chain, @linkage, @link_type, @label, @review,
      @contract_selector_hash, @contract_selectors, @contract_code_size, @selector_hash,
      @is_exploitable, @portfolio, @is_auto_audit, @is_manual_audit, @whitelist_patterns, @selectors,
      @code_size, @deployed_at, datetime('now'), datetime('now')
    )
    ON CONFLICT(chain, contract_addr) DO UPDATE SET
      deployed_at = COALESCE(contracts_registry.deployed_at, excluded.deployed_at),
      linkage = COALESCE(excluded.linkage, contracts_registry.linkage),
      link_type = COALESCE(excluded.link_type, contracts_registry.link_type),
      label = CASE WHEN excluded.label != '' THEN excluded.label ELSE contracts_registry.label END,
      review = CASE WHEN excluded.review != '' THEN excluded.review ELSE contracts_registry.review END,
      contract_selector_hash = COALESCE(excluded.contract_selector_hash, contracts_registry.contract_selector_hash),
      contract_selectors = CASE
        WHEN excluded.contract_selectors != '' THEN excluded.contract_selectors
        ELSE contracts_registry.contract_selectors
      END,
      contract_code_size = CASE
        WHEN excluded.contract_code_size > 0 THEN excluded.contract_code_size
        ELSE contracts_registry.contract_code_size
      END,
      selector_hash = COALESCE(excluded.selector_hash, contracts_registry.selector_hash),
      is_exploitable = CASE
        WHEN excluded.is_exploitable = 1 THEN 1
        ELSE contracts_registry.is_exploitable
      END,
      portfolio = CASE
        WHEN excluded.portfolio != '{}' THEN excluded.portfolio
        ELSE contracts_registry.portfolio
      END,
      is_auto_audit = CASE
        WHEN excluded.is_auto_audit = 1 THEN 1
        ELSE contracts_registry.is_auto_audit
      END,
      is_manual_audit = CASE
        WHEN excluded.is_manual_audit = 1 THEN 1
        ELSE contracts_registry.is_manual_audit
      END,
      whitelist_patterns = CASE
        WHEN excluded.whitelist_patterns != '' THEN excluded.whitelist_patterns
        ELSE contracts_registry.whitelist_patterns
      END,
      selectors = CASE
        WHEN excluded.selectors != '' THEN excluded.selectors
        ELSE contracts_registry.selectors
      END,
      code_size = CASE
        WHEN excluded.code_size > 0 THEN excluded.code_size
        ELSE contracts_registry.code_size
      END,
      updated_at = datetime('now')
  `);

  const run = getDb().transaction((entries: typeof rows) => {
    for (const row of entries) {
      const contractAddr = row.contractAddr.toLowerCase();
      insert.run({
        id: v2Id('contract', `${chainName}:${contractAddr}`),
        contract_addr: contractAddr,
        chain: chainName,
        linkage: row.linkage,
        link_type: row.linkType,
        label: row.label ?? '',
        review: row.review ?? '',
        contract_selector_hash: row.contractSelectorHash ?? null,
        contract_selectors: (row.contractSelectors ?? []).join(','),
        contract_code_size: row.contractCodeSize ?? 0,
        selector_hash: row.selectorHash,
        is_exploitable: row.isExploitable ? 1 : 0,
        portfolio: row.portfolio ?? '{}',
        deployed_at: row.deployedAt ?? null,
        is_auto_audit: row.isAutoAudit ? 1 : 0,
        is_manual_audit: row.isManualAudit ? 1 : 0,
        whitelist_patterns: [...new Set(row.whitelistPatterns)].join(','),
        selectors: [...new Set(row.selectors)].join(','),
        code_size: row.codeSize ?? 0,
      });
    }
  });

  run(rows);
}

export function updateContractPortfolioBatch(
  chain: string,
  rows: Array<{
    contractAddr: string;
    portfolio: string;
  }>,
): void {
  if (!rows.length) return;
  const update = getDb().prepare(`
    UPDATE contracts_registry
    SET portfolio = ?, updated_at = datetime('now')
    WHERE chain = ? AND contract_addr = ?
  `);
  const run = getDb().transaction((entries: typeof rows) => {
    for (const row of entries) {
      update.run(row.portfolio, chain.toLowerCase(), row.contractAddr.toLowerCase());
    }
  });
  run(rows);
}

export function updateContractDeploymentBatch(
  chain: string,
  rows: Array<{
    contractAddr: string;
    deployedAt: string | null;
  }>,
): void {
  if (!rows.length) return;
  const update = getDb().prepare(`
    UPDATE contracts_registry
    SET deployed_at = COALESCE(deployed_at, ?), updated_at = datetime('now')
    WHERE chain = ? AND contract_addr = ?
  `);
  const run = getDb().transaction((entries: typeof rows) => {
    for (const row of entries) {
      if (!row.deployedAt) continue;
      update.run(row.deployedAt, chain.toLowerCase(), row.contractAddr.toLowerCase());
    }
  });
  run(rows);
}

function mapBaseAiAuditRow(row: {
  request_session: string;
  chain: string;
  target_type: string;
  target_addr: string;
  status: string | null;
  title: string;
  provider: string;
  model: string;
  dedaub_job_id: string | null;
  analysis_session_id: string | null;
  result_path: string | null;
  critical: number | null;
  high: number | null;
  medium: number | null;
  is_success: number | null;
  requested_at: string;
  audited_at: string | null;
}) {
  return {
    requestSession: row.request_session,
    chain: row.chain.toLowerCase(),
    targetType: (row.target_type === 'token' ? 'token' : 'contract') as AiAuditTargetType,
    targetAddr: row.target_addr.toLowerCase(),
    status: deriveAiAuditLifecycleStatus({
      status: row.status,
      isSuccess: row.is_success == null ? null : Boolean(row.is_success),
      auditedAt: row.audited_at ?? null,
    }),
    title: row.title ?? '',
    provider: row.provider ?? '',
    model: row.model ?? '',
    dedaubJobId: row.dedaub_job_id ?? null,
    analysisSessionId: row.analysis_session_id ?? null,
    resultPath: row.result_path ?? null,
    critical: row.critical ?? null,
    high: row.high ?? null,
    medium: row.medium ?? null,
    isSuccess: row.is_success == null ? null : Boolean(row.is_success),
    requestedAt: row.requested_at,
    auditedAt: row.audited_at ?? null,
  };
}

function toContractAiAuditRow(row: ReturnType<typeof mapBaseAiAuditRow>): ContractAiAuditRow {
  return {
    ...row,
    contractAddr: row.targetAddr,
  };
}

function toTokenAiAuditRow(row: ReturnType<typeof mapBaseAiAuditRow>): TokenAiAuditRow {
  return {
    ...row,
    tokenAddr: row.targetAddr,
  };
}

function defaultAiAuditTitle(chain: string, targetAddr: string): string {
  const normalizedChain = String(chain || '').toLowerCase().trim();
  const normalizedTarget = String(targetAddr || '').toLowerCase().trim();
  return `ai_audit_${normalizedChain}_${normalizedTarget}`;
}

function resolveAiAuditTitle(inputTitle: string | null | undefined, chain: string, targetAddr: string): string {
  const trimmed = String(inputTitle || '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'ai auto audit') {
    return defaultAiAuditTitle(chain, targetAddr);
  }
  return trimmed;
}

function getLatestAiAudits(
  targetType: AiAuditTargetType,
  chain: string,
  addresses: string[],
): Map<string, ReturnType<typeof mapBaseAiAuditRow>> {
  const normalized = [...new Set(addresses.map((value) => value.toLowerCase()).filter(Boolean))];
  if (!normalized.length) return new Map();
  const placeholders = normalized.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT
      request_session, chain, target_type, target_addr, status, title, provider, model, result_path,
      dedaub_job_id, analysis_session_id, critical, high, medium, is_success, requested_at, audited_at
    FROM ai_audits
    WHERE chain = ?
      AND target_type = ?
      AND target_addr IN (${placeholders})
    ORDER BY requested_at DESC, request_session DESC
  `).all(chain.toLowerCase(), targetType, ...normalized) as Array<{
    request_session: string;
    chain: string;
    target_type: string;
    target_addr: string;
    status: string | null;
    title: string;
    provider: string;
    model: string;
    dedaub_job_id: string | null;
    analysis_session_id: string | null;
    result_path: string | null;
    critical: number | null;
    high: number | null;
    medium: number | null;
    is_success: number | null;
    requested_at: string;
    audited_at: string | null;
  }>;

  const out = new Map<string, ReturnType<typeof mapBaseAiAuditRow>>();
  for (const row of rows) {
    if (String(row.target_type || '') !== targetType) continue;
    const key = row.target_addr.toLowerCase();
    if (out.has(key)) continue;
    out.set(key, mapBaseAiAuditRow(row));
  }
  return out;
}

export function getLatestContractAiAudits(
  chain: string,
  addresses: string[],
): Map<string, ContractAiAuditRow> {
  const rows = getLatestAiAudits('contract', chain, addresses);
  return new Map([...rows.entries()].map(([key, row]) => [key, toContractAiAuditRow(row)]));
}

export function getLatestTokenAiAudits(
  chain: string,
  addresses: string[],
): Map<string, TokenAiAuditRow> {
  const rows = getLatestAiAudits('token', chain, addresses);
  return new Map([...rows.entries()].map(([key, row]) => [key, toTokenAiAuditRow(row)]));
}

export function getSingleContractAiAudit(
  chain: string,
  contractAddr: string,
): ContractAiAuditRow | null {
  return getLatestContractAiAudits(chain, [contractAddr]).get(contractAddr.toLowerCase()) ?? null;
}

export function getSingleTokenAiAudit(
  chain: string,
  tokenAddr: string,
): TokenAiAuditRow | null {
  return getLatestTokenAiAudits(chain, [tokenAddr]).get(tokenAddr.toLowerCase()) ?? null;
}

export function listPendingAiAudits(): BaseAiAuditRow[] {
  const rows = getDb().prepare(`
    SELECT
      request_session, chain, target_type, target_addr, status, title, provider, model, dedaub_job_id, analysis_session_id, result_path,
      critical, high, medium, is_success, requested_at, audited_at
    FROM ai_audits
    WHERE status IN ('requested', 'running')
      AND is_success IS NULL
      AND result_path IS NULL
      AND audited_at IS NULL
    ORDER BY requested_at ASC, request_session ASC
  `).all() as Array<{
    request_session: string;
    chain: string;
    target_type: string;
    target_addr: string;
    status: string | null;
    title: string;
    provider: string;
    model: string;
    dedaub_job_id: string | null;
    analysis_session_id: string | null;
    result_path: string | null;
    critical: number | null;
    high: number | null;
    medium: number | null;
    is_success: number | null;
    requested_at: string;
    audited_at: string | null;
  }>;

  return rows.map((row) => mapBaseAiAuditRow(row));
}

export function reconcileTerminalAiAuditRows(): number {
  const result = getDb().prepare(`
    UPDATE ai_audits
    SET status = CASE
      WHEN COALESCE(is_success, 0) = 1 OR result_path IS NOT NULL THEN 'completed'
      WHEN is_success = 0 THEN 'failed'
      ELSE status
    END
    WHERE status IN ('requested', 'running')
      AND (
        is_success IS NOT NULL
        OR result_path IS NOT NULL
      )
  `).run();
  return result.changes ?? 0;
}

function requestAiAudit(input: {
  targetType: AiAuditTargetType;
  chain: string;
  targetAddr: string;
  title?: string;
  provider?: string;
  model?: string;
}) {
  const chainName = input.chain.toLowerCase();
  const address = input.targetAddr.toLowerCase();
  const title = resolveAiAuditTitle(input.title, chainName, address);
  const provider = normalizeAiAuditProvider(input.provider);
  const model = normalizeAiAuditModel(provider, input.model);
  const latest = getLatestAiAudits(input.targetType, chainName, [address]).get(address);
  if (latest && (latest.status === 'requested' || latest.status === 'running')) {
    logger.info(
      `[ai-audit][state] ${input.targetType} ${chainName}:${address} session=${latest.requestSession} ${latest.status} -> ${latest.status} (reuse active request)`,
    );
    return latest;
  }

  const requestSession = v2Id('ai-audit', `${input.targetType}:${chainName}:${address}:${Date.now()}`);
  getDb().prepare(`
    INSERT INTO ai_audits (
      request_session, chain, target_type, target_addr, status, title, provider, model, dedaub_job_id, analysis_session_id, requested_at
    ) VALUES (?, ?, ?, ?, 'requested', ?, ?, ?, NULL, NULL, datetime('now'))
  `).run(
    requestSession,
    chainName,
    input.targetType,
    address,
    title,
    provider,
    model,
  );

  logger.info(
    `[ai-audit][state] ${input.targetType} ${chainName}:${address} session=${requestSession} idle -> requested`,
  );

  return getLatestAiAudits(input.targetType, chainName, [address]).get(address) ?? {
    requestSession,
    chain: chainName,
    targetType: input.targetType,
    targetAddr: address,
    status: 'requested',
    title,
    provider,
    model,
    dedaubJobId: null,
    analysisSessionId: null,
    resultPath: null,
    critical: null,
    high: null,
    medium: null,
    isSuccess: null,
    requestedAt: new Date().toISOString(),
    auditedAt: null,
  };
}

export function requestContractAiAudit(input: {
  chain: string;
  contractAddr: string;
  title?: string;
  provider?: string;
  model?: string;
}): ContractAiAuditRow {
  return toContractAiAuditRow(requestAiAudit({
    targetType: 'contract',
    chain: input.chain,
    targetAddr: input.contractAddr,
    title: input.title,
    provider: input.provider,
    model: input.model,
  }));
}

export function requestTokenAiAudit(input: {
  chain: string;
  tokenAddr: string;
  title?: string;
  provider?: string;
  model?: string;
}): TokenAiAuditRow {
  return toTokenAiAuditRow(requestAiAudit({
    targetType: 'token',
    chain: input.chain,
    targetAddr: input.tokenAddr,
    title: input.title,
    provider: input.provider,
    model: input.model,
  }));
}

export function updateAiAuditLifecycleStatus(input: {
  requestSession: string;
  status: 'requested' | 'running' | 'completed' | 'failed';
}): BaseAiAuditRow | null {
  const normalizedStatus = normalizeAiAuditLifecycleStatus(input.status) || 'requested';
  const previous = getDb().prepare(`
    SELECT request_session, chain, target_type, target_addr, status
    FROM ai_audits
    WHERE request_session = ?
    LIMIT 1
  `).get(input.requestSession) as {
    request_session: string;
    chain: string;
    target_type: string;
    target_addr: string;
    status: string | null;
  } | undefined;

  getDb().prepare(`
    UPDATE ai_audits
    SET status = ?
    WHERE request_session = ?
  `).run(normalizedStatus, input.requestSession);

  const row = getDb().prepare(`
    SELECT
      request_session, chain, target_type, target_addr, status, title, provider, model, dedaub_job_id, analysis_session_id, result_path,
      critical, high, medium, is_success, requested_at, audited_at
    FROM ai_audits
    WHERE request_session = ?
    LIMIT 1
  `).get(input.requestSession) as {
    request_session: string;
    chain: string;
    target_type: string;
    target_addr: string;
    status: string | null;
    title: string;
    provider: string;
    model: string;
    dedaub_job_id: string | null;
    analysis_session_id: string | null;
    result_path: string | null;
    critical: number | null;
    high: number | null;
    medium: number | null;
    is_success: number | null;
    requested_at: string;
    audited_at: string | null;
  } | undefined;

  if (row) {
    const previousStatus = normalizeAiAuditLifecycleStatus(previous?.status) || 'idle';
    logger.info(
      `[ai-audit][state] ${row.target_type} ${row.chain}:${row.target_addr} session=${row.request_session} ${previousStatus} -> ${row.status || normalizedStatus}`,
    );
  }

  return row ? mapBaseAiAuditRow(row) : null;
}

export function updateAiAuditBackendSessionIds(input: {
  requestSession: string;
  dedaubJobId?: string | null;
  analysisSessionId?: string | null;
}): BaseAiAuditRow | null {
  const previous = getDb().prepare(`
    SELECT request_session, chain, target_type, target_addr, status, title, provider, model, dedaub_job_id, analysis_session_id, result_path,
           critical, high, medium, is_success, requested_at, audited_at
    FROM ai_audits
    WHERE request_session = ?
    LIMIT 1
  `).get(input.requestSession) as {
    request_session: string;
    chain: string;
    target_type: string;
    target_addr: string;
    status: string | null;
    title: string;
    provider: string;
    model: string;
    dedaub_job_id: string | null;
    analysis_session_id: string | null;
    result_path: string | null;
    critical: number | null;
    high: number | null;
    medium: number | null;
    is_success: number | null;
    requested_at: string;
    audited_at: string | null;
  } | undefined;
  if (!previous) return null;

  getDb().prepare(`
    UPDATE ai_audits
    SET dedaub_job_id = COALESCE(?, dedaub_job_id),
        analysis_session_id = COALESCE(?, analysis_session_id)
    WHERE request_session = ?
  `).run(
    input.dedaubJobId ?? null,
    input.analysisSessionId ?? null,
    input.requestSession,
  );

  const row = getDb().prepare(`
    SELECT request_session, chain, target_type, target_addr, status, title, provider, model, dedaub_job_id, analysis_session_id, result_path,
           critical, high, medium, is_success, requested_at, audited_at
    FROM ai_audits
    WHERE request_session = ?
    LIMIT 1
  `).get(input.requestSession) as {
    request_session: string;
    chain: string;
    target_type: string;
    target_addr: string;
    status: string | null;
    title: string;
    provider: string;
    model: string;
    dedaub_job_id: string | null;
    analysis_session_id: string | null;
    result_path: string | null;
    critical: number | null;
    high: number | null;
    medium: number | null;
    is_success: number | null;
    requested_at: string;
    audited_at: string | null;
  } | undefined;

  return row ? mapBaseAiAuditRow(row) : null;
}

function saveAiAuditResult(input: {
  targetType: AiAuditTargetType;
  chain: string;
  targetAddr: string;
  requestSession?: string;
  title?: string;
  provider?: string;
  model?: string;
  dedaubJobId?: string | null;
  analysisSessionId?: string | null;
  resultPath?: string | null;
  critical?: number | null;
  high?: number | null;
  medium?: number | null;
  isSuccess?: boolean | null;
  auditedAt?: string | null;
}) {
  const chainName = input.chain.toLowerCase();
  const address = input.targetAddr.toLowerCase();
  const existing = input.requestSession
    ? getDb().prepare(`
      SELECT request_session, chain, target_type, target_addr, status, title, provider, model, result_path,
             dedaub_job_id, analysis_session_id, critical, high, medium, is_success, requested_at, audited_at
      FROM ai_audits
      WHERE request_session = ?
      LIMIT 1
    `).get(input.requestSession) as {
      request_session: string;
      chain: string;
      target_type: string;
      target_addr: string;
      status: string | null;
      title: string;
      provider: string;
      model: string;
      dedaub_job_id: string | null;
      analysis_session_id: string | null;
      result_path: string | null;
      critical: number | null;
      high: number | null;
      medium: number | null;
      is_success: number | null;
      requested_at: string;
      audited_at: string | null;
    } | undefined
    : undefined;

  const latest = existing ? mapBaseAiAuditRow(existing) : getLatestAiAudits(input.targetType, chainName, [address]).get(address);
  const requestSession = input.requestSession || latest?.requestSession || v2Id('ai-audit', `${input.targetType}:${chainName}:${address}:${Date.now()}`);
  const provider = normalizeAiAuditProvider(input.provider || latest?.provider || getDefaultAiAuditProvider());
  const model = normalizeAiAuditModel(provider, input.model || latest?.model || getDefaultAiAuditModel(provider));
  const title = resolveAiAuditTitle(input.title || latest?.title, chainName, address);
  const nextStatus = input.isSuccess == null
    ? (latest?.status === 'running' ? 'running' : 'requested')
    : (input.isSuccess ? 'completed' : 'failed');

  getDb().prepare(`
    INSERT INTO ai_audits (
      request_session, chain, target_type, target_addr, status, title, provider, model, dedaub_job_id, analysis_session_id, result_path,
      critical, high, medium, is_success, requested_at, audited_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(request_session) DO UPDATE SET
      status = excluded.status,
      title = excluded.title,
      provider = excluded.provider,
      model = excluded.model,
      dedaub_job_id = COALESCE(excluded.dedaub_job_id, ai_audits.dedaub_job_id),
      analysis_session_id = COALESCE(excluded.analysis_session_id, ai_audits.analysis_session_id),
      result_path = COALESCE(excluded.result_path, ai_audits.result_path),
      critical = excluded.critical,
      high = excluded.high,
      medium = excluded.medium,
      is_success = excluded.is_success,
      audited_at = COALESCE(excluded.audited_at, ai_audits.audited_at)
  `).run(
    requestSession,
    chainName,
    input.targetType,
    address,
    nextStatus,
    title,
    provider,
    model,
    input.dedaubJobId ?? latest?.dedaubJobId ?? null,
    input.analysisSessionId ?? latest?.analysisSessionId ?? null,
    input.resultPath ?? latest?.resultPath ?? null,
    input.critical ?? null,
    input.high ?? null,
    input.medium ?? null,
    input.isSuccess == null ? null : (input.isSuccess ? 1 : 0),
    input.auditedAt ?? new Date().toISOString(),
  );

  logger.info(
    `[ai-audit][state] ${input.targetType} ${chainName}:${address} session=${requestSession} ${latest?.status || 'idle'} -> ${nextStatus}`,
  );

  return getLatestAiAudits(input.targetType, chainName, [address]).get(address) ?? {
    requestSession,
    chain: chainName,
    targetType: input.targetType,
    targetAddr: address,
    status: nextStatus,
    title,
    provider,
    model,
    dedaubJobId: input.dedaubJobId ?? latest?.dedaubJobId ?? null,
    analysisSessionId: input.analysisSessionId ?? latest?.analysisSessionId ?? null,
    resultPath: input.resultPath ?? latest?.resultPath ?? null,
    critical: input.critical ?? null,
    high: input.high ?? null,
    medium: input.medium ?? null,
    isSuccess: input.isSuccess ?? null,
    requestedAt: latest?.requestedAt ?? new Date().toISOString(),
    auditedAt: input.auditedAt ?? new Date().toISOString(),
  };
}

export function saveContractAiAuditResult(input: {
  chain: string;
  contractAddr: string;
  requestSession?: string;
  title?: string;
  provider?: string;
  model?: string;
  dedaubJobId?: string | null;
  analysisSessionId?: string | null;
  resultPath?: string | null;
  critical?: number | null;
  high?: number | null;
  medium?: number | null;
  isSuccess?: boolean | null;
  auditedAt?: string | null;
}): ContractAiAuditRow {
  const row = saveAiAuditResult({
    targetType: 'contract',
    chain: input.chain,
    targetAddr: input.contractAddr,
    requestSession: input.requestSession,
    title: input.title,
    provider: input.provider,
    model: input.model,
    dedaubJobId: input.dedaubJobId,
    analysisSessionId: input.analysisSessionId,
    resultPath: input.resultPath,
    critical: input.critical,
    high: input.high,
    medium: input.medium,
    isSuccess: input.isSuccess,
    auditedAt: input.auditedAt,
  });
  if (input.isSuccess === true) {
    getDb().prepare(`
      UPDATE contracts_registry
      SET is_auto_audit = 1, updated_at = datetime('now')
      WHERE chain = ? AND contract_addr = ?
    `).run(input.chain.toLowerCase(), input.contractAddr.toLowerCase());
  }
  return toContractAiAuditRow(row);
}

export function saveTokenAiAuditResult(input: {
  chain: string;
  tokenAddr: string;
  requestSession?: string;
  title?: string;
  provider?: string;
  model?: string;
  dedaubJobId?: string | null;
  analysisSessionId?: string | null;
  resultPath?: string | null;
  critical?: number | null;
  high?: number | null;
  medium?: number | null;
  isSuccess?: boolean | null;
  auditedAt?: string | null;
}): TokenAiAuditRow {
  const row = saveAiAuditResult({
    targetType: 'token',
    chain: input.chain,
    targetAddr: input.tokenAddr,
    requestSession: input.requestSession,
    title: input.title,
    provider: input.provider,
    model: input.model,
    dedaubJobId: input.dedaubJobId,
    analysisSessionId: input.analysisSessionId,
    resultPath: input.resultPath,
    critical: input.critical,
    high: input.high,
    medium: input.medium,
    isSuccess: input.isSuccess,
    auditedAt: input.auditedAt,
  });
  if (input.isSuccess === true) {
    getDb().prepare(`
      UPDATE tokens_registry
      SET is_auto_audited = 1, updated_at = datetime('now')
      WHERE chain = ? AND address = ?
    `).run(input.chain.toLowerCase(), input.tokenAddr.toLowerCase());
  }
  return toTokenAiAuditRow(row);
}

export type AiAuditLifecycleStatus = 'requested' | 'running' | 'completed' | 'failed';
export type AutoAuditSummaryStatus = 'yes' | 'no' | 'processing' | 'failed';

function isLifecycleStatus(value: unknown): value is AiAuditLifecycleStatus {
  return value === 'requested' || value === 'running' || value === 'completed' || value === 'failed';
}

export function normalizeAiAuditLifecycleStatus(value: unknown): AiAuditLifecycleStatus | null {
  const normalized = String(value || '').trim().toLowerCase();
  return isLifecycleStatus(normalized) ? normalized : null;
}

export function deriveAiAuditLifecycleStatus(input: {
  status?: unknown;
  isSuccess?: boolean | null;
  auditedAt?: string | null;
}): AiAuditLifecycleStatus {
  const explicit = normalizeAiAuditLifecycleStatus(input.status);
  if (explicit) return explicit;
  if (input.auditedAt == null) return 'requested';
  return input.isSuccess === false ? 'failed' : 'completed';
}

export function deriveAutoAuditSummaryStatus(
  registry: { isAutoAudit?: boolean; isAutoAudited?: boolean } | undefined,
  audit: { status?: unknown; isSuccess?: boolean | null; auditedAt?: string | null } | undefined,
): AutoAuditSummaryStatus {
  if (audit) {
    const lifecycle = deriveAiAuditLifecycleStatus(audit);
    if (lifecycle === 'failed') return 'failed';
    if (lifecycle === 'requested' || lifecycle === 'running') return 'processing';
    if (lifecycle === 'completed') return 'yes';
  }

  const autoAudit = (registry as { isAutoAudit?: boolean } | undefined)?.isAutoAudit;
  const autoAudited = (registry as { isAutoAudited?: boolean } | undefined)?.isAutoAudited;
  if (autoAudit || autoAudited) return 'yes';
  return 'no';
}

import type { DashboardContractSummary, DashboardTokenSummary } from '../modules/dashboard/read-model.js';

function compareNumberLike(a: number | null | undefined, b: number | null | undefined): number {
  return (Number(a) || 0) - (Number(b) || 0);
}

function compareStringLike(a: string | null | undefined, b: string | null | undefined): number {
  return String(a || '').localeCompare(String(b || ''));
}

function compareAuditSeverity(
  a: { auto_audit_critical?: number | null; auto_audit_high?: number | null; auto_audit_medium?: number | null },
  b: { auto_audit_critical?: number | null; auto_audit_high?: number | null; auto_audit_medium?: number | null },
): number {
  const criticalDelta = compareNumberLike(a.auto_audit_critical ?? 0, b.auto_audit_critical ?? 0);
  if (criticalDelta !== 0) return criticalDelta;
  const highDelta = compareNumberLike(a.auto_audit_high ?? 0, b.auto_audit_high ?? 0);
  if (highDelta !== 0) return highDelta;
  return compareNumberLike(a.auto_audit_medium ?? 0, b.auto_audit_medium ?? 0);
}

export function applyDashboardContractQuery(
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
    const isSeen = Boolean(row.is_seen_pattern || row.is_manual_audit || row.group_kind === 'seen');
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
      case 'audit_result':
        delta = compareAuditSeverity(a, b);
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

export function applyDashboardTokenQuery(
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
        delta = compareAuditSeverity(a, b);
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
      case 'processing':
        delta = compareNumberLike(a.processing_percent, b.processing_percent);
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

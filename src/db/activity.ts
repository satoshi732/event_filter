import { getDb } from './core.js';

export interface UserDailyActivityRow {
  activityDate: string;
  username: string;
  syncPatternCount: number;
  reviewCount: number;
  autoAnalysisCount: number;
}

export interface UserDailyActivitySeriesRow {
  date: string;
  sync_pattern_count: number;
  review_count: number;
  auto_analysis_count: number;
}

export interface DashboardInventorySummary {
  contracts_total: number;
  contracts_analyzed: number;
  tokens_total: number;
  tokens_analyzed: number;
}

function normalizeUsername(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function utcDateKey(input: Date | string | number = Date.now()): string {
  const date = input instanceof Date ? input : new Date(input);
  return date.toISOString().slice(0, 10);
}

function buildUtcDateRange(days: number): string[] {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 14;
  const out: string[] = [];
  const today = new Date();
  const utcNow = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (let index = safeDays - 1; index >= 0; index -= 1) {
    out.push(new Date(utcNow - (index * 86_400_000)).toISOString().slice(0, 10));
  }
  return out;
}

export function incrementUserDailyActivity(
  username: string,
  patch: {
    syncPatternCount?: number;
    reviewCount?: number;
    autoAnalysisCount?: number;
  },
): void {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) return;
  const syncPatternCount = Math.max(0, Math.floor(Number(patch.syncPatternCount) || 0));
  const reviewCount = Math.max(0, Math.floor(Number(patch.reviewCount) || 0));
  const autoAnalysisCount = Math.max(0, Math.floor(Number(patch.autoAnalysisCount) || 0));
  if (!syncPatternCount && !reviewCount && !autoAnalysisCount) return;

  getDb().prepare(`
    INSERT INTO user_daily_activity (
      activity_date,
      username,
      sync_pattern_count,
      review_count,
      auto_analysis_count,
      created_at,
      updated_at
    ) VALUES (
      @activity_date,
      @username,
      @sync_pattern_count,
      @review_count,
      @auto_analysis_count,
      datetime('now'),
      datetime('now')
    )
    ON CONFLICT(activity_date, username) DO UPDATE SET
      sync_pattern_count = user_daily_activity.sync_pattern_count + excluded.sync_pattern_count,
      review_count = user_daily_activity.review_count + excluded.review_count,
      auto_analysis_count = user_daily_activity.auto_analysis_count + excluded.auto_analysis_count,
      updated_at = datetime('now')
  `).run({
    activity_date: utcDateKey(),
    username: normalizedUsername,
    sync_pattern_count: syncPatternCount,
    review_count: reviewCount,
    auto_analysis_count: autoAnalysisCount,
  });
}

export function getUserDailyActivitySeries(username: string, days = 14): UserDailyActivitySeriesRow[] {
  const normalizedUsername = normalizeUsername(username);
  const range = buildUtcDateRange(days);
  if (!normalizedUsername) {
    return range.map((date) => ({
      date,
      sync_pattern_count: 0,
      review_count: 0,
      auto_analysis_count: 0,
    }));
  }

  const rows = getDb().prepare(`
    SELECT
      activity_date,
      sync_pattern_count,
      review_count,
      auto_analysis_count
    FROM user_daily_activity
    WHERE username = ?
      AND activity_date >= ?
    ORDER BY activity_date ASC
  `).all(normalizedUsername, range[0]) as Array<{
    activity_date: string;
    sync_pattern_count: number;
    review_count: number;
    auto_analysis_count: number;
  }>;

  const rowMap = new Map(rows.map((row) => [row.activity_date, row] as const));
  return range.map((date) => {
    const row = rowMap.get(date);
    return {
      date,
      sync_pattern_count: row?.sync_pattern_count ?? 0,
      review_count: row?.review_count ?? 0,
      auto_analysis_count: row?.auto_analysis_count ?? 0,
    };
  });
}

export function getGlobalSyncPatternDailySeries(days = 14): Array<{ date: string; count: number }> {
  const range = buildUtcDateRange(days);
  const rows = getDb().prepare(`
    SELECT
      substr(created_at, 1, 10) AS activity_date,
      COUNT(*) AS count
    FROM seen_selectors
    WHERE substr(created_at, 1, 10) >= ?
    GROUP BY substr(created_at, 1, 10)
    ORDER BY activity_date ASC
  `).all(range[0]) as Array<{
    activity_date: string;
    count: number | null;
  }>;

  const rowMap = new Map(rows.map((row) => [row.activity_date, Number(row.count) || 0] as const));
  return range.map((date) => ({
    date,
    count: rowMap.get(date) ?? 0,
  }));
}

export function getDashboardInventorySummary(chains: string[]): DashboardInventorySummary {
  const normalizedChains = [...new Set(
    (chains || []).map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean),
  )];
  if (!normalizedChains.length) {
    return {
      contracts_total: 0,
      contracts_analyzed: 0,
      tokens_total: 0,
      tokens_analyzed: 0,
    };
  }

  const placeholders = normalizedChains.map(() => '?').join(', ');
  const contracts = getDb().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_manual_audit = 1 OR is_auto_audit = 1 THEN 1 ELSE 0 END) AS analyzed
    FROM contracts_registry
    WHERE chain IN (${placeholders})
  `).get(...normalizedChains) as { total: number | null; analyzed: number | null } | undefined;

  const tokens = getDb().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_manual_audited = 1 OR is_auto_audited = 1 THEN 1 ELSE 0 END) AS analyzed
    FROM tokens_registry
    WHERE chain IN (${placeholders})
  `).get(...normalizedChains) as { total: number | null; analyzed: number | null } | undefined;

  return {
    contracts_total: Number(contracts?.total) || 0,
    contracts_analyzed: Number(contracts?.analyzed) || 0,
    tokens_total: Number(tokens?.total) || 0,
    tokens_analyzed: Number(tokens?.analyzed) || 0,
  };
}

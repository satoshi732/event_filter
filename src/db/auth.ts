import { getDb } from './core.js';

export type AuthUserRole = 'admin' | 'user';

export interface AuthUserRow {
  username: string;
  passwordHash: string;
  role: AuthUserRole;
  aiApiKey: string;
  allowedChains: string[];
  dailyReviewTarget: number;
  createdAt: string;
  updatedAt: string;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

function stringifyJsonArray(values: string[]): string {
  return JSON.stringify(
    [...new Set((values || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))],
  );
}

function normalizeRole(value: string | null | undefined): AuthUserRole {
  return String(value || '').trim().toLowerCase() === 'admin' ? 'admin' : 'user';
}

function normalizeDailyReviewTarget(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : 200;
}

export function listAuthUsers(): AuthUserRow[] {
  const rows = getDb().prepare(`
    SELECT username, password_hash, role, ai_api_key, allowed_chains, daily_review_target, created_at, updated_at
    FROM auth_users
    ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END ASC, username ASC
  `).all() as Array<{
    username: string;
    password_hash: string;
    role: string;
    ai_api_key: string | null;
    allowed_chains: string | null;
    daily_review_target: number | null;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    username: row.username,
    passwordHash: row.password_hash,
    role: normalizeRole(row.role),
    aiApiKey: String(row.ai_api_key || '').trim(),
    allowedChains: parseJsonArray(row.allowed_chains),
    dailyReviewTarget: normalizeDailyReviewTarget(row.daily_review_target),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getAuthUser(username: string): AuthUserRow | null {
  const normalized = String(username || '').trim();
  if (!normalized) return null;
  const row = getDb().prepare(`
    SELECT username, password_hash, role, ai_api_key, allowed_chains, daily_review_target, created_at, updated_at
    FROM auth_users
    WHERE lower(username) = lower(?)
    LIMIT 1
  `).get(normalized) as {
    username: string;
    password_hash: string;
    role: string;
    ai_api_key: string | null;
    allowed_chains: string | null;
    daily_review_target: number | null;
    created_at: string;
    updated_at: string;
  } | undefined;
  if (!row) return null;
  return {
    username: row.username,
    passwordHash: row.password_hash,
    role: normalizeRole(row.role),
    aiApiKey: String(row.ai_api_key || '').trim(),
    allowedChains: parseJsonArray(row.allowed_chains),
    dailyReviewTarget: normalizeDailyReviewTarget(row.daily_review_target),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function replaceAuthUsers(rows: Array<{
  username: string;
  passwordHash: string;
  role: AuthUserRole;
  aiApiKey?: string;
  allowedChains?: string[];
  dailyReviewTarget?: number;
}>): void {
  const normalized = rows
    .map((row) => ({
      username: String(row.username || '').trim(),
      passwordHash: String(row.passwordHash || '').trim(),
      role: normalizeRole(row.role),
      aiApiKey: String(row.aiApiKey || '').trim(),
      allowedChains: [...new Set((row.allowedChains || []).map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean))],
      dailyReviewTarget: normalizeDailyReviewTarget(row.dailyReviewTarget),
    }))
    .filter((row) => row.username && row.passwordHash);

  const run = getDb().transaction((entries: typeof normalized) => {
    const del = getDb().prepare('DELETE FROM auth_users');
    const ins = getDb().prepare(`
      INSERT INTO auth_users (
        username, password_hash, role, ai_api_key, allowed_chains, daily_review_target, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    del.run();
    for (const row of entries) {
      ins.run(row.username, row.passwordHash, row.role, row.aiApiKey, stringifyJsonArray(row.allowedChains), row.dailyReviewTarget);
    }
  });
  run(normalized);
}

export function upsertAuthUser(row: {
  username: string;
  passwordHash: string;
  role: AuthUserRole;
  aiApiKey?: string;
  allowedChains?: string[];
  dailyReviewTarget?: number;
}): void {
  getDb().prepare(`
    INSERT INTO auth_users (
      username, password_hash, role, ai_api_key, allowed_chains, daily_review_target, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      role = excluded.role,
      ai_api_key = excluded.ai_api_key,
      allowed_chains = excluded.allowed_chains,
      daily_review_target = excluded.daily_review_target,
      updated_at = datetime('now')
  `).run(
    String(row.username || '').trim(),
    String(row.passwordHash || '').trim(),
    normalizeRole(row.role),
    String(row.aiApiKey || '').trim(),
    stringifyJsonArray(row.allowedChains || []),
    normalizeDailyReviewTarget(row.dailyReviewTarget),
  );
}

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getAppSetting,
  listAuthUsers,
  replaceAuthUsers,
  setAppSetting,
} from '../db.js';
import { hashPassword } from './web-security.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const LEGACY_USER_FILE_PATH = path.join(ROOT, 'user.json');

interface LegacyUserFileShape {
  auth_enabled?: boolean;
  username?: string;
  password_hash?: string;
  password?: string;
  role?: string;
  users?: Array<{
    username?: string;
    password_hash?: string;
    password?: string;
    role?: string;
    ai_api_key?: string;
    aiApiKey?: string;
    allowed_chains?: string[];
    allowedChains?: string[];
    daily_review_target?: number;
    dailyReviewTarget?: number;
  }>;
}

export type UserRole = 'admin' | 'user';

export interface UserAuthAccount {
  username: string;
  passwordHash: string;
  role: UserRole;
  aiApiKey: string;
  allowedChains: string[];
  dailyReviewTarget: number;
}

export interface UserAuthConfig {
  authEnabled: boolean;
  username: string;
  passwordHash: string;
  role: UserRole;
  users: UserAuthAccount[];
}

function normalizeUsername(value: string): string {
  return String(value || '').trim();
}

export function normalizeUserRole(value: string | null | undefined): UserRole {
  return String(value || '').trim().toLowerCase() === 'admin' ? 'admin' : 'user';
}

function passwordHashFor(raw: { password_hash?: string; password?: string }): string {
  const passwordHash = String(raw.password_hash || '').trim();
  if (passwordHash) return passwordHash;
  const password = String(raw.password || '');
  return password ? hashPassword(password) : '';
}

function aiApiKeyFor(raw: { ai_api_key?: string; aiApiKey?: string }): string {
  return String(raw.ai_api_key ?? raw.aiApiKey ?? '').trim();
}

function allowedChainsFor(raw: { allowed_chains?: string[]; allowedChains?: string[] }): string[] {
  const source = Array.isArray(raw.allowed_chains)
    ? raw.allowed_chains
    : (Array.isArray(raw.allowedChains) ? raw.allowedChains : []);
  return [...new Set(source.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean))];
}

function dailyReviewTargetFor(raw: { daily_review_target?: number; dailyReviewTarget?: number }): number {
  const parsed = Number(raw.daily_review_target ?? raw.dailyReviewTarget);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : 200;
}

function ensureAdminPresence(users: UserAuthAccount[]): UserAuthAccount[] {
  const nextUsers = [...users];
  if (nextUsers.length > 0 && !nextUsers.some((user) => user.role === 'admin')) {
    nextUsers[0] = { ...nextUsers[0], role: 'admin' };
  }
  return nextUsers;
}

function serializeUsersForConfig(users: UserAuthAccount[]): UserAuthConfig {
  const sortedUsers = [...users].sort((a, b) => {
    if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
    return a.username.localeCompare(b.username);
  });
  const primary = sortedUsers[0] || { username: '', passwordHash: '', role: 'user' as UserRole, aiApiKey: '', allowedChains: [], dailyReviewTarget: 200 };
  return {
    authEnabled: getAppSetting('auth_enabled') !== '0',
    username: primary.username,
    passwordHash: primary.passwordHash,
    role: primary.role,
    users: sortedUsers,
  };
}

function normalizeDbUsers(): UserAuthAccount[] {
  return listAuthUsers().map((user) => ({
    username: user.username,
    passwordHash: user.passwordHash,
    role: normalizeUserRole(user.role),
    aiApiKey: user.aiApiKey,
    allowedChains: [...new Set((user.allowedChains || []).map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean))],
    dailyReviewTarget: user.dailyReviewTarget,
  }));
}

function normalizeLegacyConfig(raw: LegacyUserFileShape): UserAuthAccount[] {
  const usersByName = new Map<string, UserAuthAccount>();
  const addUser = (entry: { username?: string; password_hash?: string; password?: string; role?: string; ai_api_key?: string; aiApiKey?: string; allowed_chains?: string[]; allowedChains?: string[]; daily_review_target?: number; dailyReviewTarget?: number }) => {
    const username = normalizeUsername(String(entry.username || ''));
    if (!username) return;
    const passwordHash = passwordHashFor(entry);
    if (!passwordHash) return;
    usersByName.set(username.toLowerCase(), {
      username,
      passwordHash,
      role: normalizeUserRole(entry.role),
      aiApiKey: aiApiKeyFor(entry),
      allowedChains: allowedChainsFor(entry),
      dailyReviewTarget: dailyReviewTargetFor(entry),
    });
  };

  if (Array.isArray(raw.users)) raw.users.forEach(addUser);
  if (raw.username || raw.password_hash || raw.password) {
    addUser({
      username: raw.username,
      password_hash: raw.password_hash,
      password: raw.password,
      role: raw.role || 'admin',
    });
  }

  return Array.from(usersByName.values());
}

function migrateLegacyUserFileIfNeeded(): void {
  const existingUsers = normalizeDbUsers();
  if (existingUsers.length) return;

  const legacyRaw = existsSync(LEGACY_USER_FILE_PATH)
    ? JSON.parse(readFileSync(LEGACY_USER_FILE_PATH, 'utf8')) as LegacyUserFileShape
    : null;
  let users = legacyRaw ? normalizeLegacyConfig(legacyRaw) : [];
  if (!users.some((user) => user.username.toLowerCase() === 'kecheng')) {
    users.push({
      username: 'kecheng',
      role: 'user',
      passwordHash: hashPassword('kecheng'),
      aiApiKey: '',
      allowedChains: [],
      dailyReviewTarget: 200,
    });
  }
  users = ensureAdminPresence(users);
  if (!users.length) return;
  if (legacyRaw?.auth_enabled === false) {
    setAppSetting('auth_enabled', '0');
  }

  replaceAuthUsers(users.map((user) => ({
    username: user.username,
    passwordHash: user.passwordHash,
    role: user.role,
    aiApiKey: user.aiApiKey,
    allowedChains: user.allowedChains,
    dailyReviewTarget: user.dailyReviewTarget,
  })));
}

export function getUserAuthConfig(): UserAuthConfig {
  migrateLegacyUserFileIfNeeded();
  const dbUsers = normalizeDbUsers();
  const users = ensureAdminPresence(dbUsers);
  if (users.length !== dbUsers.length || users.some((user, index) => user.role !== dbUsers[index]?.role)) {
    replaceAuthUsers(users.map((user) => ({
      username: user.username,
      passwordHash: user.passwordHash,
      role: user.role,
      aiApiKey: user.aiApiKey,
      allowedChains: user.allowedChains,
      dailyReviewTarget: user.dailyReviewTarget,
    })));
  }
  return serializeUsersForConfig(users);
}

export function findUserAuthAccount(config: UserAuthConfig, username: string): UserAuthAccount | null {
  const normalized = normalizeUsername(username).toLowerCase();
  if (!normalized) return null;
  return config.users.find((user) => user.username.toLowerCase() === normalized) || null;
}

export function isAdminUser(config: UserAuthConfig, username: string): boolean {
  const user = findUserAuthAccount(config, username);
  return Boolean(user && user.role === 'admin');
}

function persistUsers(users: UserAuthAccount[]): UserAuthConfig {
  const normalized = ensureAdminPresence(users);
  replaceAuthUsers(normalized.map((user) => ({
    username: user.username,
    passwordHash: user.passwordHash,
    role: user.role,
    aiApiKey: user.aiApiKey,
    allowedChains: user.allowedChains,
    dailyReviewTarget: user.dailyReviewTarget,
  })));
  return getUserAuthConfig();
}

export function updateOwnUserAuthAccount(
  currentUsername: string,
  input: {
    username?: string;
    newPassword?: string;
    aiApiKey?: string;
    allowedChains?: string[];
    dailyReviewTarget?: number;
  },
): { previousUsername: string; user: UserAuthAccount; config: UserAuthConfig } {
  const config = getUserAuthConfig();
  const normalizedCurrent = normalizeUsername(currentUsername).toLowerCase();
  const index = config.users.findIndex((user) => user.username.toLowerCase() === normalizedCurrent);
  if (index < 0) throw new Error('current user was not found');

  const previous = config.users[index];
  const nextUsername = normalizeUsername(input.username ?? previous.username);
  if (!nextUsername) throw new Error('username is required');
  const nextUsernameKey = nextUsername.toLowerCase();
  const duplicate = config.users.some((user, userIndex) => userIndex !== index && user.username.toLowerCase() === nextUsernameKey);
  if (duplicate) throw new Error('username already exists');

  const newPassword = String(input.newPassword || '');
  const nextUser: UserAuthAccount = {
    ...previous,
    username: nextUsername,
    aiApiKey: String(input.aiApiKey ?? previous.aiApiKey ?? '').trim(),
    allowedChains: [...new Set((input.allowedChains ?? previous.allowedChains ?? []).map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean))],
    dailyReviewTarget: dailyReviewTargetFor({ dailyReviewTarget: input.dailyReviewTarget ?? previous.dailyReviewTarget }),
  };
  if (newPassword) {
    if (newPassword.length < 4) throw new Error('new password must be at least 4 characters');
    nextUser.passwordHash = hashPassword(newPassword);
  }

  const users = [...config.users];
  users[index] = nextUser;
  const nextConfig = persistUsers(users);
  return {
    previousUsername: previous.username,
    user: findUserAuthAccount(nextConfig, nextUsername) || nextUser,
    config: nextConfig,
  };
}

export function createManagedUser(
  currentUsername: string,
  input: {
    username?: string;
    password?: string;
    role?: string;
  },
): { user: UserAuthAccount; config: UserAuthConfig } {
  const config = getUserAuthConfig();
  const actor = findUserAuthAccount(config, currentUsername);
  if (!actor || actor.role !== 'admin') throw new Error('admin access is required');

  const username = normalizeUsername(String(input.username || ''));
  if (!username) throw new Error('username is required');
  if (config.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('username already exists');
  }

  const password = String(input.password || '');
  if (password.length < 4) throw new Error('password must be at least 4 characters');

  const nextUser: UserAuthAccount = {
    username,
    passwordHash: hashPassword(password),
    role: normalizeUserRole(input.role),
    aiApiKey: '',
    allowedChains: [],
    dailyReviewTarget: 200,
  };
  const nextConfig = persistUsers([...config.users, nextUser]);
  return {
    user: findUserAuthAccount(nextConfig, username) || nextUser,
    config: nextConfig,
  };
}

export function deleteManagedUser(
  currentUsername: string,
  targetUsername: string,
): UserAuthConfig {
  const config = getUserAuthConfig();
  const actor = findUserAuthAccount(config, currentUsername);
  if (!actor || actor.role !== 'admin') throw new Error('admin access is required');

  const targetKey = normalizeUsername(targetUsername).toLowerCase();
  if (!targetKey) throw new Error('username is required');
  if (targetKey === normalizeUsername(currentUsername).toLowerCase()) {
    throw new Error('you cannot delete your own account here');
  }

  const target = config.users.find((user) => user.username.toLowerCase() === targetKey);
  if (!target) throw new Error('user was not found');

  if (target.role === 'admin') {
    const otherAdmins = config.users.filter((user) => user.role === 'admin' && user.username.toLowerCase() !== targetKey);
    if (!otherAdmins.length) {
      throw new Error('at least one admin account must remain');
    }
  }

  return persistUsers(config.users.filter((user) => user.username.toLowerCase() !== targetKey));
}

export function updateUserAllowedChains(
  updates: Array<{ username?: string; allowedChains?: string[] }>,
): UserAuthConfig {
  const config = getUserAuthConfig();
  const updatesByName = new Map<string, string[]>();

  (updates || []).forEach((entry) => {
    const username = normalizeUsername(String(entry.username || '')).toLowerCase();
    if (!username) return;
    updatesByName.set(
      username,
      [...new Set((entry.allowedChains || []).map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean))],
    );
  });

  if (!updatesByName.size) return config;

  let changed = false;
  const users = config.users.map((user) => {
    const nextAllowedChains = updatesByName.get(user.username.toLowerCase());
    if (!nextAllowedChains) return user;
    const currentAllowedChains = [...new Set((user.allowedChains || []).map((chain) => String(chain || '').trim().toLowerCase()).filter(Boolean))];
    if (currentAllowedChains.length === nextAllowedChains.length && currentAllowedChains.every((chain, index) => chain === nextAllowedChains[index])) {
      return user;
    }
    changed = true;
    return { ...user, allowedChains: nextAllowedChains };
  });

  return changed ? persistUsers(users) : config;
}

export function getAllowedChainsForUser(
  config: UserAuthConfig,
  username: string,
  allChains: string[],
): string[] {
  const normalizedAll = [...new Set((allChains || []).map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean))];
  const user = findUserAuthAccount(config, username);
  if (!user) return normalizedAll;
  if (user.role === 'admin') return normalizedAll;
  if (!user.allowedChains.length) return normalizedAll;
  const allowed = new Set(user.allowedChains);
  return normalizedAll.filter((chain) => allowed.has(chain));
}

import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hashPassword } from './web-security.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const USER_FILE_PATH = path.join(ROOT, 'user.json');

interface UserFileShape {
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
  }>;
}

export type UserRole = 'admin' | 'user';

export interface UserAuthAccount {
  username: string;
  passwordHash: string;
  role: UserRole;
  aiApiKey: string;
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

function normalizeUserConfig(raw: UserFileShape): UserAuthConfig {
  const usersByName = new Map<string, UserAuthAccount>();
  const addUser = (entry: { username?: string; password_hash?: string; password?: string; role?: string; ai_api_key?: string; aiApiKey?: string }) => {
    const username = normalizeUsername(String(entry.username || ''));
    if (!username) return;
    const passwordHash = passwordHashFor(entry);
    if (!passwordHash) return;
    usersByName.set(username.toLowerCase(), {
      username,
      passwordHash,
      role: normalizeUserRole(entry.role),
      aiApiKey: aiApiKeyFor(entry),
    });
  };

  if (Array.isArray(raw.users)) {
    raw.users.forEach(addUser);
  }
  if (raw.username || raw.password_hash || raw.password) {
    addUser({
      username: raw.username,
      password_hash: raw.password_hash,
      password: raw.password,
      role: raw.role || 'admin',
      ai_api_key: raw.users?.find((item) => normalizeUsername(String(item.username || '')).toLowerCase() === normalizeUsername(String(raw.username || '')).toLowerCase())?.ai_api_key,
    });
  }

  let users = Array.from(usersByName.values());
  if (users.length > 0 && !users.some((user) => user.role === 'admin')) {
    users = users.map((user, index) => index === 0 ? { ...user, role: 'admin' } : user);
  }
  users.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
    return a.username.localeCompare(b.username);
  });
  const primary = users[0] || { username: '', passwordHash: '', role: 'user' as UserRole, aiApiKey: '' };
  return {
    authEnabled: raw.auth_enabled !== false,
    username: primary.username,
    passwordHash: primary.passwordHash,
    role: primary.role,
    users,
  };
}

function serializeUserConfig(config: UserAuthConfig) {
  return {
    auth_enabled: config.authEnabled,
    users: config.users.map((user) => ({
      username: user.username,
      role: user.role,
      password_hash: user.passwordHash,
      ai_api_key: user.aiApiKey,
    })),
  };
}

function ensureDefaultUsers(config: UserAuthConfig): { config: UserAuthConfig; changed: boolean } {
  let changed = false;
  const users = [...config.users];
  if (!users.some((user) => user.username.toLowerCase() === 'kecheng')) {
    users.push({
      username: 'kecheng',
      role: 'user',
      passwordHash: hashPassword('kecheng'),
      aiApiKey: '',
    });
    changed = true;
  }
  if (!users.some((user) => user.role === 'admin') && users.length > 0) {
    users[0] = { ...users[0], role: 'admin' };
    changed = true;
  }
  users.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
    return a.username.localeCompare(b.username);
  });
  const primary = users[0] || { username: '', passwordHash: '', role: 'user' as UserRole, aiApiKey: '' };
  return {
    changed,
    config: {
      ...config,
      username: primary.username,
      passwordHash: primary.passwordHash,
      role: primary.role,
      users,
    },
  };
}

export function ensureUserAuthFile(): UserAuthConfig {
  if (!existsSync(USER_FILE_PATH)) {
    throw new Error(`Missing user auth file: ${USER_FILE_PATH}`);
  }

  const raw = JSON.parse(readFileSync(USER_FILE_PATH, 'utf8')) as UserFileShape;
  const normalizedResult = ensureDefaultUsers(normalizeUserConfig(raw));
  const normalized = normalizedResult.config;
  if (!normalized.username) {
    throw new Error(`Invalid user auth file: username is required in ${USER_FILE_PATH}`);
  }
  if (!normalized.passwordHash) {
    if (String(raw.password || '').trim()) {
      const persisted = serializeUserConfig(normalized);
      writeFileSync(USER_FILE_PATH, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
      return normalizeUserConfig(persisted);
    }
    throw new Error(`Invalid user auth file: password_hash is required in ${USER_FILE_PATH}`);
  }
  const shouldPersist = normalizedResult.changed
    || !Array.isArray(raw.users)
    || Boolean(raw.password)
    || Boolean(raw.username || raw.password_hash);
  if (shouldPersist) {
    writeFileSync(USER_FILE_PATH, `${JSON.stringify(serializeUserConfig(normalized), null, 2)}\n`, 'utf8');
  }
  return normalized;
}

export function getUserAuthConfig(): UserAuthConfig {
  return ensureUserAuthFile();
}

function saveUserAuthConfig(config: UserAuthConfig): UserAuthConfig {
  writeFileSync(USER_FILE_PATH, `${JSON.stringify(serializeUserConfig(config), null, 2)}\n`, 'utf8');
  return normalizeUserConfig(serializeUserConfig(config));
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

export function updateOwnUserAuthAccount(
  currentUsername: string,
  input: {
    username?: string;
    newPassword?: string;
    aiApiKey?: string;
  },
): { previousUsername: string; user: UserAuthAccount; config: UserAuthConfig } {
  const config = ensureUserAuthFile();
  const normalizedCurrent = normalizeUsername(currentUsername).toLowerCase();
  const index = config.users.findIndex((user) => user.username.toLowerCase() === normalizedCurrent);
  if (index < 0) {
    throw new Error('current user was not found');
  }

  const previous = config.users[index];
  const nextUsername = normalizeUsername(input.username ?? previous.username);
  if (!nextUsername) throw new Error('username is required');
  const nextUsernameKey = nextUsername.toLowerCase();
  const duplicate = config.users.some((user, userIndex) => (
    userIndex !== index && user.username.toLowerCase() === nextUsernameKey
  ));
  if (duplicate) throw new Error('username already exists');

  const newPassword = String(input.newPassword || '');
  const nextUser: UserAuthAccount = {
    ...previous,
    username: nextUsername,
    aiApiKey: String(input.aiApiKey ?? previous.aiApiKey ?? '').trim(),
  };
  if (newPassword) {
    if (newPassword.length < 4) throw new Error('new password must be at least 4 characters');
    nextUser.passwordHash = hashPassword(newPassword);
  }

  const users = [...config.users];
  users[index] = nextUser;
  users.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
    return a.username.localeCompare(b.username);
  });
  const nextConfig = saveUserAuthConfig({
    ...config,
    users,
    username: users[0]?.username || '',
    passwordHash: users[0]?.passwordHash || '',
    role: users[0]?.role || 'user',
  });
  return {
    previousUsername: previous.username,
    user: findUserAuthAccount(nextConfig, nextUsername) || nextUser,
    config: nextConfig,
  };
}

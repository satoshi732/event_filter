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
}

export interface UserAuthConfig {
  authEnabled: boolean;
  username: string;
  passwordHash: string;
}

function normalizeUserConfig(raw: UserFileShape): UserAuthConfig {
  const username = String(raw.username || '').trim();
  const passwordHash = String(raw.password_hash || '').trim();
  const password = String(raw.password || '');
  return {
    authEnabled: raw.auth_enabled !== false,
    username,
    passwordHash: passwordHash || (password ? hashPassword(password) : ''),
  };
}

export function ensureUserAuthFile(): UserAuthConfig {
  if (!existsSync(USER_FILE_PATH)) {
    throw new Error(`Missing user auth file: ${USER_FILE_PATH}`);
  }

  const raw = JSON.parse(readFileSync(USER_FILE_PATH, 'utf8')) as UserFileShape;
  const normalized = normalizeUserConfig(raw);
  if (!normalized.username) {
    throw new Error(`Invalid user auth file: username is required in ${USER_FILE_PATH}`);
  }
  if (!normalized.passwordHash) {
    if (String(raw.password || '').trim()) {
      const persisted = {
        auth_enabled: normalized.authEnabled,
        username: normalized.username,
        password_hash: hashPassword(String(raw.password || '')),
      };
      writeFileSync(USER_FILE_PATH, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
      return normalizeUserConfig(persisted);
    }
    throw new Error(`Invalid user auth file: password_hash is required in ${USER_FILE_PATH}`);
  }
  return normalized;
}

export function getUserAuthConfig(): UserAuthConfig {
  return ensureUserAuthFile();
}

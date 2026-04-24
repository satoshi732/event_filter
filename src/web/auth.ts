import type { IncomingMessage, ServerResponse } from 'http';

interface WebSession {
  username: string;
  expiresAt: number;
}

export interface AuthenticatedSession {
  token: string;
  session: WebSession;
}

export interface UserAuthLike {
  authEnabled: boolean;
  username: string;
  passwordHash: string;
  users?: Array<{
    username: string;
    passwordHash: string;
    role: 'admin' | 'user';
    aiApiKey?: string;
    allowedChains?: string[];
  }>;
}

const SESSION_COOKIE_NAME = 'solana_mev_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const sessions = new Map<string, WebSession>();

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const raw = String(header || '').trim();
  if (!raw) return result;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.split('=');
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) continue;
    result[normalizedKey] = decodeURIComponent(rest.join('=').trim());
  }
  return result;
}

function createSessionToken(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function getAuthenticatedSession(req: IncomingMessage): AuthenticatedSession | null {
  purgeExpiredSessions();
  const cookies = parseCookies(req.headers.cookie);
  const token = String(cookies[SESSION_COOKIE_NAME] || '').trim();
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, session };
}

export function createAuthenticatedSession(username: string): string {
  const token = createSessionToken();
  sessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export function renameAuthenticatedSessions(previousUsername: string, nextUsername: string): void {
  const previous = String(previousUsername || '').trim().toLowerCase();
  const next = String(nextUsername || '').trim();
  if (!previous || !next) return;
  for (const [token, session] of sessions.entries()) {
    if (String(session.username || '').trim().toLowerCase() === previous) {
      sessions.set(token, {
        ...session,
        username: next,
      });
    }
  }
}

export function findUserAuthAccount(userAuth: UserAuthLike, username: string) {
  const normalized = String(username || '').trim().toLowerCase();
  if (!normalized) return null;
  const users = Array.isArray(userAuth.users) ? userAuth.users : [];
  const user = users.find((item) => String(item.username || '').trim().toLowerCase() === normalized);
  if (user) return user;
  if (String(userAuth.username || '').trim().toLowerCase() === normalized) {
    return {
      username: userAuth.username,
      passwordHash: userAuth.passwordHash,
      role: 'admin' as const,
      aiApiKey: '',
      allowedChains: [],
    };
  }
  return null;
}

export function isAdminAuthUser(userAuth: UserAuthLike, username: string): boolean {
  return findUserAuthAccount(userAuth, username)?.role === 'admin';
}

export function revokeAuthenticatedSession(token: string | null | undefined): void {
  if (!token) return;
  sessions.delete(String(token));
}

export function setSessionCookie(res: ServerResponse, token: string, secure: boolean): void {
  const cookie = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
}

export function clearSessionCookie(res: ServerResponse, secure: boolean): void {
  const cookie = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
}

export function isPublicRequest(
  method: string,
  reqPath: string,
  isStaticAssetRequest: (reqPath: string) => boolean,
): boolean {
  return (method === 'GET' && reqPath === '/login')
    || (method === 'POST' && reqPath === '/api/login')
    || (method === 'POST' && reqPath === '/api/logout')
    || (method === 'GET' && isStaticAssetRequest(reqPath));
}

export function enforceAuthentication(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    method: string;
    reqPath: string;
    isApiRequest: boolean;
    isPageRequest: boolean;
    isPublicRequest: boolean;
    userAuth: UserAuthLike;
    activeSession: AuthenticatedSession | null;
    sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void;
  },
): boolean {
  const {
    method,
    reqPath,
    isApiRequest,
    isPageRequest,
    isPublicRequest: publicRequest,
    userAuth,
    activeSession,
    sendJson,
  } = options;

  if (!userAuth.authEnabled) return true;
  const configuredUsers = Array.isArray(userAuth.users) && userAuth.users.length
    ? userAuth.users
    : (userAuth.username && userAuth.passwordHash ? [{
      username: userAuth.username,
      passwordHash: userAuth.passwordHash,
      role: 'admin' as const,
    }] : []);
  if (!configuredUsers.length) {
    res.writeHead(503, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end('Authentication is enabled but not configured correctly');
    return false;
  }
  if (publicRequest || activeSession) return true;

  if (isApiRequest) {
    sendJson(res, 401, { error: 'Authentication required', auth_required: true });
    return false;
  }

  if (isPageRequest || method === 'GET') {
    const nextValue = req.url && req.url !== '/login' ? req.url : '/';
    res.writeHead(302, {
      Location: `/login?next=${encodeURIComponent(nextValue || '/')}`,
      'Cache-Control': 'no-store',
    });
    res.end();
    return false;
  }

  return true;
}

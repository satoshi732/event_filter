import type { IncomingMessage, ServerResponse } from 'http';
import { verifyPassword } from '../utils/web-security.js';
import { findUserAuthAccount, type AuthenticatedSession, type UserAuthLike } from './auth.js';

interface LoginRouteDeps {
  method: string;
  reqPath: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  userAuth: UserAuthLike;
  activeSession: AuthenticatedSession | null;
  secureCookies: boolean;
  renderPage: (res: ServerResponse, viewPath: string, data: Record<string, unknown>) => Promise<void>;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  sendJson: (res: ServerResponse, statusCode: number, body: unknown) => void;
  createAuthenticatedSession: (username: string) => string;
  revokeAuthenticatedSession: (token: string | null | undefined) => void;
  setSessionCookie: (res: ServerResponse, token: string, secure: boolean) => void;
  clearSessionCookie: (res: ServerResponse, secure: boolean) => void;
}

export async function handleLoginRoutes(deps: LoginRouteDeps): Promise<boolean> {
  const {
    method,
    reqPath,
    req,
    res,
    url,
    userAuth,
    activeSession,
    secureCookies,
    renderPage,
    readJsonBody,
    sendJson,
    createAuthenticatedSession,
    revokeAuthenticatedSession,
    setSessionCookie,
    clearSessionCookie,
  } = deps;

  if (method === 'GET' && reqPath === '/login') {
    if (!userAuth.authEnabled || activeSession) {
      res.writeHead(302, {
        Location: String(url.searchParams.get('next') || '/'),
        'Cache-Control': 'no-store',
      });
      res.end();
      return true;
    }
    await renderPage(res, 'pages/login.ejs', {
      title: 'Sign In',
      next: String(url.searchParams.get('next') || '/'),
    });
    return true;
  }

  if (method === 'POST' && reqPath === '/api/login') {
    if (!userAuth.authEnabled) {
      sendJson(res, 200, { ok: true, next: '/' });
      return true;
    }
    const body = await readJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const nextPath = String(body.next || '/').trim() || '/';
    const account = findUserAuthAccount(userAuth, username);
    const authenticated = Boolean(account && verifyPassword(password, account.passwordHash));
    if (!authenticated) {
      sendJson(res, 401, { error: 'Invalid username or password' });
      return true;
    }
    const token = createAuthenticatedSession(account?.username || username);
    setSessionCookie(res, token, secureCookies);
    sendJson(res, 200, { ok: true, next: nextPath });
    return true;
  }

  if (method === 'POST' && reqPath === '/api/logout') {
    revokeAuthenticatedSession(activeSession?.token);
    clearSessionCookie(res, secureCookies);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

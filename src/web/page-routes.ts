import type { ServerResponse } from 'http';

export const appPageRoutes = new Set([
  '/',
  '/token',
  '/token.html',
  '/token-detail',
  '/token-detail.html',
  '/contract',
  '/contract.html',
]);

interface PageRouteDeps {
  method: string;
  reqPath: string;
  res: ServerResponse;
  authEnabled: boolean;
  currentUser: string;
  renderPage: (res: ServerResponse, viewPath: string, data: Record<string, unknown>) => Promise<void>;
}

export async function handleAppPageRoutes(deps: PageRouteDeps): Promise<boolean> {
  const {
    method,
    reqPath,
    res,
    authEnabled,
    currentUser,
    renderPage,
  } = deps;

  if (method !== 'GET') return false;

  if (reqPath === '/') {
    await renderPage(res, 'pages/dashboard.ejs', {
      title: 'Solana Mev Labs',
      initialView: 'dashboard',
      authEnabled,
      currentUser,
    });
    return true;
  }

  if (reqPath === '/token' || reqPath === '/token.html') {
    await renderPage(res, 'pages/dashboard.ejs', {
      title: 'Token Directory',
      initialView: 'token',
      authEnabled,
      currentUser,
    });
    return true;
  }

  if (reqPath === '/token-detail' || reqPath === '/token-detail.html') {
    await renderPage(res, 'pages/dashboard.ejs', {
      title: 'Token Detail',
      initialView: 'token-detail',
      authEnabled,
      currentUser,
    });
    return true;
  }

  if (reqPath === '/contract' || reqPath === '/contract.html') {
    await renderPage(res, 'pages/dashboard.ejs', {
      title: 'Contract Detail',
      initialView: 'contract',
      authEnabled,
      currentUser,
    });
    return true;
  }

  return false;
}

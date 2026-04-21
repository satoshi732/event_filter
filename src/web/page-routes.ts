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
  currentUserRole: string;
  isAdmin: boolean;
  renderPage: (res: ServerResponse, viewPath: string, data: Record<string, unknown>) => Promise<void>;
}

export async function handleAppPageRoutes(deps: PageRouteDeps): Promise<boolean> {
  const {
    method,
    reqPath,
    res,
    authEnabled,
    currentUser,
    currentUserRole,
    isAdmin,
    renderPage,
  } = deps;

  if (method !== 'GET') return false;
  const basePageData = {
    authEnabled,
    currentUser,
    currentUserRole,
    isAdmin,
  };

  if (reqPath === '/') {
    await renderPage(res, 'pages/dashboard.ejs', {
      title: 'Solana Mev Labs',
      initialView: 'dashboard',
      ...basePageData,
    });
    return true;
  }

  if (reqPath === '/token' || reqPath === '/token.html') {
    await renderPage(res, 'pages/dashboard.ejs', {
      title: 'Token Directory',
      initialView: 'token',
      ...basePageData,
    });
    return true;
  }

  if (reqPath === '/token-detail' || reqPath === '/token-detail.html') {
    await renderPage(res, 'pages/dashboard.ejs', {
      title: 'Token Detail',
      initialView: 'token-detail',
      ...basePageData,
    });
    return true;
  }

  if (reqPath === '/contract' || reqPath === '/contract.html') {
    await renderPage(res, 'pages/dashboard.ejs', {
      title: 'Contract Detail',
      initialView: 'contract',
      ...basePageData,
    });
    return true;
  }

  return false;
}

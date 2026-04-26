import type { ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import path from 'path';

const DASHBOARD_BUNDLE_REQUEST_PATH = '/js/dashboard-bundle.js';
const DASHBOARD_BUNDLE_FILES = [
  'dashboard-shared.js',
  'dashboard-runtime.js',
  'dashboard-scroll-sync.js',
  'dashboard-table-state.js',
  'dashboard-view-state.js',
  'dashboard-data.js',
  'dashboard-loaders.js',
  'dashboard-actions.js',
  'dashboard-modals.js',
  'dashboard-routing.js',
];

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function isStaticAssetRequest(reqPath: string): boolean {
  if (reqPath === DASHBOARD_BUNDLE_REQUEST_PATH) return true;
  if (!reqPath || reqPath === '/') return false;
  const ext = path.extname(reqPath).toLowerCase();
  return ['.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.map'].includes(ext);
}

async function readDashboardBundle(publicDir: string): Promise<Buffer> {
  const parts = await Promise.all(
    DASHBOARD_BUNDLE_FILES.map(async (filename) => {
      const filePath = path.join(publicDir, 'js', filename);
      const source = await readFile(filePath, 'utf-8');
      return `\n/* ---- ${filename} ---- */\n${source.trim()}\n`;
    }),
  );
  return Buffer.from(parts.join('\n'), 'utf-8');
}

export async function serveStaticAsset(reqPath: string, publicDir: string, res: ServerResponse): Promise<void> {
  const candidate = reqPath === '/'
    ? path.join(publicDir, 'index.html')
    : path.join(publicDir, reqPath.replace(/^\/+/, ''));
  const filePath = path.normalize(candidate);

  if (!filePath.startsWith(publicDir)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const file = reqPath === DASHBOARD_BUNDLE_REQUEST_PATH
      ? await readDashboardBundle(publicDir)
      : await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.js' ? 'text/javascript; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(file);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

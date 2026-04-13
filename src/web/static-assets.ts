import type { ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import path from 'path';

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function isStaticAssetRequest(reqPath: string): boolean {
  if (!reqPath || reqPath === '/') return false;
  const ext = path.extname(reqPath).toLowerCase();
  return ['.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.map'].includes(ext);
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
    const file = await readFile(filePath);
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

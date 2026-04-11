import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDebugEnabled } from '../config.js';

const ROOT    = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const LOG_DIR = path.join(ROOT, 'logs');
mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = path.join(LOG_DIR, `app-${new Date().toISOString().slice(0, 10)}.log`);

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 23);

function write(line: string): void {
  try { appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore fs errors */ }
}

function emit(line: string, consoleFn: (s: string) => void): void {
  consoleFn(line);
  write(line);
}

export const logger = {
  info: (msg: string) => {
    emit(`[${ts()}] INFO  ${msg}`, console.log);
  },
  warn: (msg: string) => {
    emit(`[${ts()}] WARN  ${msg}`, console.warn);
  },
  error: (msg: string, err?: unknown) => {
    const detail = err instanceof Error ? err.message : (err ? String(err) : '');
    emit(`[${ts()}] ERROR ${msg}${detail ? ' — ' + detail : ''}`, console.error);
  },
  debug: (msg: string) => {
    if (!getDebugEnabled()) return;
    emit(`[${ts()}] DEBUG ${msg}`, console.log);
  },
  hr: () => {
    const line = '─'.repeat(80);
    emit(line, console.log);
  },
};

import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const HASH_PREFIX = 'scrypt';
const HASH_BYTES = 64;

function toUtf8Buffer(value: string): Buffer {
  return Buffer.from(String(value || ''), 'utf8');
}

export function hashPassword(password: string): string {
  const normalized = String(password || '');
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(normalized, salt, HASH_BYTES).toString('hex');
  return `${HASH_PREFIX}:${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string | null | undefined): boolean {
  const raw = String(storedHash || '').trim();
  if (!raw) return false;

  const [prefix, salt, expectedHex] = raw.split(':');
  if (prefix !== HASH_PREFIX || !salt || !expectedHex) return false;

  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = scryptSync(String(password || ''), salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function safeEqualString(left: string, right: string): boolean {
  const leftBuffer = toUtf8Buffer(left);
  const rightBuffer = toUtf8Buffer(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  try {
    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

import { createHash } from 'crypto';
import { containsCall } from '../../analyzer/bytecode.js';
import { selectorHash } from '../../utils/selector-pattern.js';

const UNISWAP_V2_SYNC_SELECTOR = '0xfff6cae9';

export function resolvePatternHash(selectors: string[], bytecode: string, fallbackScope: string): string {
  if (selectors.length > 0) {
    return selectorHash(selectors);
  }
  const normalizedBytecode = (bytecode ?? '').trim().toLowerCase().replace(/^0x/, '');
  if (normalizedBytecode) {
    return `code:${createHash('sha256').update(normalizedBytecode).digest('hex')}`;
  }
  return `nosel:${createHash('sha256').update(fallbackScope.toLowerCase()).digest('hex')}`;
}

export function detectSyncCallPattern(bytecode: string): boolean {
  if (!bytecode) return false;
  return containsCall(bytecode, UNISWAP_V2_SYNC_SELECTOR);
}

export function safeBigInt(value: string | null | undefined): bigint {
  try {
    return BigInt(value ?? '0');
  } catch {
    return 0n;
  }
}

import { createHash } from 'crypto';

export function selectorHash(selectors: string[]): string {
  const sorted = [...new Set(selectors.map((value) => value.toLowerCase()))].sort().join(',');
  return createHash('sha256').update(sorted).digest('hex');
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function codeSizeDiverges(a: number, b: number): boolean {
  if (a === 0 || b === 0) return false;
  const ratio = Math.abs(a - b) / Math.max(a, b);
  return ratio > 0.05;
}

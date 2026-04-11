export const MAX_TOKEN_PRICE_USD = 500_000;

export function sanitizeTokenPriceUsd(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < 0) return 0;
  if (numeric > MAX_TOKEN_PRICE_USD) return 0;
  return numeric;
}

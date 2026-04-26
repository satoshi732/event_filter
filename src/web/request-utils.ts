export function sanitizeRuntimeConfig<T extends { web_security?: Record<string, unknown> | null }>(snapshot: T): T {
  const access = snapshot.web_security ?? {};
  return {
    ...snapshot,
    web_security: {
      ...access,
    },
  };
}

export function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
  }
  if (typeof value === 'string') {
    return [...new Set(
      value
        .split(/\r?\n|,/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    )];
  }
  return [];
}

export function coercePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function coerceBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

export function normalizeAiModelRows(
  providers: Array<{ provider: string; enabled: boolean; position: number }>,
  models: Array<{ provider: string; model: string; enabled: boolean; isDefault: boolean; position: number }>,
): Array<{ provider: string; model: string; enabled: boolean; isDefault: boolean; position: number }> {
  const activeProviders = new Set(providers.map((row) => row.provider.trim().toLowerCase()).filter(Boolean));
  const filtered = models
    .map((row) => ({
      provider: row.provider.trim().toLowerCase(),
      model: row.model.trim(),
      enabled: row.enabled,
      isDefault: row.isDefault,
      position: row.position,
    }))
    .filter((row) => row.provider && row.model && activeProviders.has(row.provider));

  const byProvider = new Map<string, typeof filtered>();
  for (const row of filtered) {
    const bucket = byProvider.get(row.provider) ?? [];
    bucket.push(row);
    byProvider.set(row.provider, bucket);
  }

  for (const rows of byProvider.values()) {
    rows.sort((a, b) => a.position - b.position || a.model.localeCompare(b.model));
    if (!rows.some((row) => row.isDefault)) {
      if (rows[0]) rows[0].isDefault = true;
      continue;
    }
    let seenDefault = false;
    for (const row of rows) {
      if (row.isDefault && !seenDefault) {
        seenDefault = true;
      } else if (row.isDefault) {
        row.isDefault = false;
      }
    }
  }

  return filtered;
}

export function parseOptionalBlockInput(value: unknown): number | null | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) return null;
  return parsed;
}

export function parseOptionalDeltaInput(value: unknown): number | null | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) return null;
  return parsed;
}

export function normalizeDateTimeLocalInput(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return '';
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return '';
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

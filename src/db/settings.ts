import { getDb } from './core.js';

export interface AppSettingRow {
  key: string;
  value: string;
  updatedAt: string;
}

export interface ChainSettingRow {
  chain: string;
  name: string;
  chainId: number;
  tablePrefix: string;
  blocksPerScan: number;
  chainbaseKeys: string[];
  rpcUrls: string[];
  multicall3Address: string;
  nativeCurrencyName: string;
  nativeCurrencySymbol: string;
  nativeCurrencyDecimals: number;
  updatedAt: string;
}

export interface AiAuditProviderRow {
  provider: string;
  enabled: boolean;
  position: number;
  updatedAt: string;
}

export interface AiAuditModelRow {
  id: number;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  position: number;
  updatedAt: string;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => String(value || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function stringifyJsonArray(values: string[]): string {
  return JSON.stringify(
    [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))],
  );
}

export function listAppSettings(): AppSettingRow[] {
  const rows = getDb().prepare(`
    SELECT key, value, updated_at
    FROM app_settings
    ORDER BY key ASC
  `).all() as Array<{ key: string; value: string; updated_at: string }>;
  return rows.map((row) => ({
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
  }));
}

export function getAppSetting(key: string): string | null {
  const row = getDb().prepare(`
    SELECT value
    FROM app_settings
    WHERE key = ?
    LIMIT 1
  `).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(key, value);
}

export function setManyAppSettings(entries: Array<{ key: string; value: string }>): void {
  const run = getDb().transaction((items: Array<{ key: string; value: string }>) => {
    const stmt = getDb().prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `);
    for (const item of items) {
      stmt.run(item.key, item.value);
    }
  });
  run(entries);
}

export function listChainSettings(): ChainSettingRow[] {
  const rows = getDb().prepare(`
    SELECT
      chain,
      name,
      chain_id,
      table_prefix,
      blocks_per_scan,
      chainbase_keys,
      rpc_urls,
      multicall3_address,
      native_currency_name,
      native_currency_symbol,
      native_currency_decimals,
      updated_at
    FROM chain_settings
    ORDER BY chain ASC
  `).all() as Array<{
    chain: string;
    name: string | null;
    chain_id: number | null;
    table_prefix: string | null;
    blocks_per_scan: number;
    chainbase_keys: string;
    rpc_urls: string;
    multicall3_address: string;
    native_currency_name: string | null;
    native_currency_symbol: string | null;
    native_currency_decimals: number | null;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    chain: row.chain,
    name: row.name ?? '',
    chainId: row.chain_id ?? 0,
    tablePrefix: row.table_prefix ?? '',
    blocksPerScan: row.blocks_per_scan,
    chainbaseKeys: parseJsonArray(row.chainbase_keys),
    rpcUrls: parseJsonArray(row.rpc_urls),
    multicall3Address: row.multicall3_address,
    nativeCurrencyName: row.native_currency_name ?? '',
    nativeCurrencySymbol: row.native_currency_symbol ?? '',
    nativeCurrencyDecimals: row.native_currency_decimals ?? 18,
    updatedAt: row.updated_at,
  }));
}

export function upsertChainSettings(rows: Array<{
  chain: string;
  name: string;
  chainId: number;
  tablePrefix: string;
  blocksPerScan: number;
  chainbaseKeys: string[];
  rpcUrls: string[];
  multicall3Address: string;
  nativeCurrencyName: string;
  nativeCurrencySymbol: string;
  nativeCurrencyDecimals: number;
}>): void {
  const run = getDb().transaction((entries: typeof rows) => {
    const stmt = getDb().prepare(`
      INSERT INTO chain_settings (
        chain, name, chain_id, table_prefix, blocks_per_scan,
        chainbase_keys, rpc_urls, multicall3_address,
        native_currency_name, native_currency_symbol, native_currency_decimals, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(chain) DO UPDATE SET
        name = excluded.name,
        chain_id = excluded.chain_id,
        table_prefix = excluded.table_prefix,
        blocks_per_scan = excluded.blocks_per_scan,
        chainbase_keys = excluded.chainbase_keys,
        rpc_urls = excluded.rpc_urls,
        multicall3_address = excluded.multicall3_address,
        native_currency_name = excluded.native_currency_name,
        native_currency_symbol = excluded.native_currency_symbol,
        native_currency_decimals = excluded.native_currency_decimals,
        updated_at = datetime('now')
    `);
    for (const row of entries) {
      stmt.run(
        row.chain.toLowerCase(),
        row.name.trim(),
        row.chainId,
        row.tablePrefix.trim(),
        row.blocksPerScan,
        stringifyJsonArray(row.chainbaseKeys),
        stringifyJsonArray(row.rpcUrls),
        row.multicall3Address.trim().toLowerCase(),
        row.nativeCurrencyName.trim(),
        row.nativeCurrencySymbol.trim(),
        row.nativeCurrencyDecimals,
      );
    }
  });
  run(rows);
}

export function replaceChainSettings(rows: Array<{
  chain: string;
  name: string;
  chainId: number;
  tablePrefix: string;
  blocksPerScan: number;
  chainbaseKeys: string[];
  rpcUrls: string[];
  multicall3Address: string;
  nativeCurrencyName: string;
  nativeCurrencySymbol: string;
  nativeCurrencyDecimals: number;
}>): void {
  const normalized = rows
    .map((row) => ({
      chain: row.chain.toLowerCase().trim(),
      name: row.name.trim(),
      chainId: row.chainId,
      tablePrefix: row.tablePrefix.trim(),
      blocksPerScan: row.blocksPerScan,
      chainbaseKeys: row.chainbaseKeys,
      rpcUrls: row.rpcUrls,
      multicall3Address: row.multicall3Address,
      nativeCurrencyName: row.nativeCurrencyName,
      nativeCurrencySymbol: row.nativeCurrencySymbol,
      nativeCurrencyDecimals: row.nativeCurrencyDecimals,
    }))
    .filter((row) => row.chain);

  const db = getDb();
  const run = db.transaction((entries: typeof normalized) => {
    db.prepare(`DELETE FROM chain_settings`).run();
    if (!entries.length) return;
    const stmt = db.prepare(`
      INSERT INTO chain_settings (
        chain, name, chain_id, table_prefix, blocks_per_scan,
        chainbase_keys, rpc_urls, multicall3_address,
        native_currency_name, native_currency_symbol, native_currency_decimals, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    for (const row of entries) {
      stmt.run(
        row.chain,
        row.name,
        row.chainId,
        row.tablePrefix,
        row.blocksPerScan,
        stringifyJsonArray(row.chainbaseKeys),
        stringifyJsonArray(row.rpcUrls),
        row.multicall3Address.trim().toLowerCase(),
        row.nativeCurrencyName.trim(),
        row.nativeCurrencySymbol.trim(),
        row.nativeCurrencyDecimals,
      );
    }
  });
  run(normalized);
}

export function listAiAuditProviders(): AiAuditProviderRow[] {
  const rows = getDb().prepare(`
    SELECT provider, enabled, position, updated_at
    FROM ai_audit_providers
    ORDER BY position ASC, provider ASC
  `).all() as Array<{
    provider: string;
    enabled: number;
    position: number;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    provider: row.provider,
    enabled: Boolean(row.enabled),
    position: row.position,
    updatedAt: row.updated_at,
  }));
}

export function replaceAiAuditProviders(rows: Array<{
  provider: string;
  enabled: boolean;
  position: number;
}>): void {
  const db = getDb();
  const run = db.transaction((entries: typeof rows) => {
    db.prepare(`DELETE FROM ai_audit_providers`).run();
    const stmt = db.prepare(`
      INSERT INTO ai_audit_providers (provider, enabled, position, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `);
    for (const row of entries) {
      const provider = row.provider.trim().toLowerCase();
      if (!provider) continue;
      stmt.run(provider, row.enabled ? 1 : 0, row.position);
    }
  });
  run(rows);
}

export function listAiAuditModels(): AiAuditModelRow[] {
  const rows = getDb().prepare(`
    SELECT id, provider, model, enabled, is_default, position, updated_at
    FROM ai_audit_models
    ORDER BY provider ASC, position ASC, id ASC
  `).all() as Array<{
    id: number;
    provider: string;
    model: string;
    enabled: number;
    is_default: number;
    position: number;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    model: row.model,
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.is_default),
    position: row.position,
    updatedAt: row.updated_at,
  }));
}

export function replaceAiAuditModels(rows: Array<{
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  position: number;
}>): void {
  const db = getDb();
  const run = db.transaction((entries: typeof rows) => {
    db.prepare(`DELETE FROM ai_audit_models`).run();
    const stmt = db.prepare(`
      INSERT INTO ai_audit_models (provider, model, enabled, is_default, position, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    for (const row of entries) {
      const provider = row.provider.trim().toLowerCase();
      const model = row.model.trim();
      if (!provider || !model) continue;
      stmt.run(provider, model, row.enabled ? 1 : 0, row.isDefault ? 1 : 0, row.position);
    }
  });
  run(rows);
}

import { getDb, backupDatabaseToFile } from './db/core.js';
import { PatternRow, PrimitiveDbSnapshot } from './db/types.js';

export * from './db/types.js';
export * from './db/core.js';
export * from './db/raw-data.js';
export * from './db/tokens.js';
export * from './db/contracts.js';
export * from './db/selectors.js';
export * from './db/settings.js';
export * from './db/auth.js';
export * from './db/activity.js';

export function getWhitelistPatterns(): PatternRow[] {
  return getDb().prepare(`
    SELECT id, name, hex_pattern, pattern_type, description, created_by_username
    FROM whitelist_patterns
    ORDER BY name ASC, id ASC
  `).all() as PatternRow[];
}

export function addWhitelistPattern(
  name: string,
  hexPattern: string,
  patternType: string,
  description = '',
  createdByUsername = '',
): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO whitelist_patterns (name, hex_pattern, pattern_type, description, created_by_username)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, hexPattern.toLowerCase(), patternType, description, String(createdByUsername || '').trim().toLowerCase());
  console.log(`whitelist pattern added: ${name} (${hexPattern})`);
}

export function removeWhitelistPattern(name: string): void {
  const r = getDb().prepare('DELETE FROM whitelist_patterns WHERE name = ?').run(name);
  console.log(r.changes > 0 ? `removed: ${name}` : `not found: ${name}`);
}

export function replaceWhitelistPatterns(rows: Array<{
  id?: number;
  name: string;
  hexPattern: string;
  patternType: string;
  description?: string;
  createdByUsername?: string;
}>, actorUsername = ''): number {
  const normalized = rows
    .map((row) => ({
      id: Number.isFinite(Number(row.id)) ? Number(row.id) : null,
      name: String(row.name || '').trim(),
      hexPattern: String(row.hexPattern || '').trim().toLowerCase().replace(/^0x/, ''),
      patternType: String(row.patternType || 'selector').trim().toLowerCase() || 'selector',
      description: String(row.description || '').trim(),
      createdByUsername: String(row.createdByUsername || '').trim().toLowerCase(),
    }))
    .filter((row) => row.name && row.hexPattern);

  const db = getDb();
  const previousRows = db.prepare(`
    SELECT id, name, created_by_username
    FROM whitelist_patterns
    ORDER BY id ASC
  `).all() as Array<{ id: number; name: string; created_by_username: string }>;
  const previousById = new Map(previousRows.map((row) => [row.id, row] as const));
  const previousByName = new Map(previousRows.map((row) => [row.name, row] as const));
  const previousNames = new Set(previousRows.map((row) => row.name));
  const normalizedActor = String(actorUsername || '').trim().toLowerCase();
  const insert = db.prepare(`
    INSERT INTO whitelist_patterns (name, hex_pattern, pattern_type, description, created_by_username)
    VALUES (?, ?, ?, ?, ?)
  `);

  const run = db.transaction((entries: typeof normalized) => {
    db.prepare('DELETE FROM whitelist_patterns').run();
    for (const row of entries) {
      const existing = (row.id != null ? previousById.get(row.id) : null) || previousByName.get(row.name);
      const owner = row.createdByUsername || existing?.created_by_username || normalizedActor;
      insert.run(row.name, row.hexPattern, row.patternType, row.description, owner);
    }
  });

  run(normalized);
  return normalized.filter((row) => !previousNames.has(row.name)).length;
}

export function listWhitelistPatterns(): void {
  const rows = getDb().prepare('SELECT * FROM whitelist_patterns ORDER BY name ASC, id ASC').all() as PatternRow[];
  if (!rows.length) { console.log('(empty)'); return; }
  console.log('name                           hex_pattern  type      description');
  console.log('-'.repeat(80));
  for (const r of rows) {
    console.log(`${r.name.padEnd(31)} ${r.hex_pattern.padEnd(13)} ${r.pattern_type.padEnd(10)} ${r.description}`);
  }
}

export function getPrimitiveDbSnapshot(): PrimitiveDbSnapshot {
  const db = getDb();
  const whitelistPatterns = db.prepare(`
    SELECT id, name, hex_pattern, pattern_type, description, created_by_username, created_at
    FROM whitelist_patterns
    ORDER BY id ASC
  `).all() as PrimitiveDbSnapshot['whitelist_patterns'];

  const seenSelectorsRows = db.prepare(`
    SELECT hash, label, selectors, level, bytecode_size, created_by_username, created_at
    FROM seen_selectors
    ORDER BY created_at ASC
  `).all() as Array<{
    hash: string;
    label: string;
    selectors: string;
    level: number | null;
    bytecode_size: number;
    created_by_username: string;
    created_at: string;
  }>;

  const selectorsTempRows = db.prepare(`
    SELECT
      id, chain, contract_addr, selector_hash, selectors, label,
      bytecode_size, prepared_by_username, status, last_error, created_at, updated_at
    FROM selectors_temp
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{
    id: string;
    chain: string;
    contract_addr: string;
    selector_hash: string;
    selectors: string;
    label: string;
    bytecode_size: number;
    prepared_by_username: string;
    status: string;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const tokensRegistry = db.prepare(`
    SELECT
      chain, address, name, symbol, decimals, token_kind,
      price_usd, is_auto_audited, is_manual_audited, is_native,
      created, calls_sync, selector_hash, selectors, code_size, seen_label, updated_at
    FROM tokens_registry
    ORDER BY chain ASC, address ASC
  `).all() as PrimitiveDbSnapshot['tokens_registry'];

  const syncState = db.prepare(`
    SELECT remote_name, last_pull_at, last_push_at, last_verify_at, updated_at
    FROM pattern_sync_state
    ORDER BY remote_name ASC
  `).all() as PrimitiveDbSnapshot['pattern_sync_state'];

  return {
    created_at: new Date().toISOString(),
    whitelist_patterns: whitelistPatterns,
    seen_selectors: seenSelectorsRows.map((row) => ({
      ...row,
      selectors: row.selectors.split(',').filter(Boolean),
    })),
    selectors_temp: selectorsTempRows.map((row) => ({
      ...row,
      selectors: row.selectors.split(',').filter(Boolean),
    })),
    tokens_registry: tokensRegistry,
    pattern_sync_state: syncState,
  };
}

export { backupDatabaseToFile };

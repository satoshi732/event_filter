import { getDb, backupDatabaseToFile } from './db/core.js';
import { PatternRow, PrimitiveDbSnapshot } from './db/types.js';

export * from './db/types.js';
export * from './db/core.js';
export * from './db/raw-data.js';
export * from './db/tokens.js';
export * from './db/contracts.js';
export * from './db/selectors.js';
export * from './db/settings.js';

export function getWhitelistPatterns(): PatternRow[] {
  return getDb().prepare(`
    SELECT id, name, hex_pattern, pattern_type, score, description
    FROM whitelist_patterns
    ORDER BY score DESC, name ASC, id ASC
  `).all() as PatternRow[];
}

export function addWhitelistPattern(name: string, hexPattern: string, patternType: string, score: number, description = ''): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO whitelist_patterns (name, hex_pattern, pattern_type, score, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, hexPattern.toLowerCase(), patternType, score, description);
  console.log(`whitelist pattern added: ${name} (${hexPattern}) score=${score}`);
}

export function removeWhitelistPattern(name: string): void {
  const r = getDb().prepare('DELETE FROM whitelist_patterns WHERE name = ?').run(name);
  console.log(r.changes > 0 ? `removed: ${name}` : `not found: ${name}`);
}

export function replaceWhitelistPatterns(rows: Array<{
  name: string;
  hexPattern: string;
  patternType: string;
  score: number;
  description?: string;
}>): void {
  const normalized = rows
    .map((row) => ({
      name: String(row.name || '').trim(),
      hexPattern: String(row.hexPattern || '').trim().toLowerCase().replace(/^0x/, ''),
      patternType: String(row.patternType || 'selector').trim().toLowerCase() || 'selector',
      score: Number.isFinite(Number(row.score)) ? Math.floor(Number(row.score)) : 1,
      description: String(row.description || '').trim(),
    }))
    .filter((row) => row.name && row.hexPattern);

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO whitelist_patterns (name, hex_pattern, pattern_type, score, description)
    VALUES (?, ?, ?, ?, ?)
  `);

  const run = db.transaction((entries: typeof normalized) => {
    db.prepare('DELETE FROM whitelist_patterns').run();
    for (const row of entries) {
      insert.run(row.name, row.hexPattern, row.patternType, row.score, row.description);
    }
  });

  run(normalized);
}

export function listWhitelistPatterns(): void {
  const rows = getDb().prepare('SELECT * FROM whitelist_patterns ORDER BY score DESC, name').all() as PatternRow[];
  if (!rows.length) { console.log('(empty)'); return; }
  console.log('name                           hex_pattern  type      score  description');
  console.log('-'.repeat(80));
  for (const r of rows) {
    console.log(`${r.name.padEnd(31)} ${r.hex_pattern.padEnd(13)} ${r.pattern_type.padEnd(10)} ${String(r.score).padEnd(7)} ${r.description}`);
  }
}

export function getPrimitiveDbSnapshot(): PrimitiveDbSnapshot {
  const db = getDb();
  const whitelistPatterns = db.prepare(`
    SELECT id, name, hex_pattern, pattern_type, score, description, created_at
    FROM whitelist_patterns
    ORDER BY id ASC
  `).all() as PrimitiveDbSnapshot['whitelist_patterns'];

  const seenSelectorsRows = db.prepare(`
    SELECT hash, label, selectors, level, bytecode_size, created_at
    FROM seen_selectors
    ORDER BY created_at ASC
  `).all() as Array<{
    hash: string;
    label: string;
    selectors: string;
    level: number | null;
    bytecode_size: number;
    created_at: string;
  }>;

  const selectorsTempRows = db.prepare(`
    SELECT
      id, chain, contract_addr, selector_hash, selectors, label,
      bytecode_size, status, last_error, created_at, updated_at
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
    status: string;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const tokensRegistry = db.prepare(`
    SELECT
      chain, address, name, symbol, decimals, token_kind,
      price_usd, is_auto_audited, is_manual_audited, is_native,
      created, calls_sync, updated_at
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

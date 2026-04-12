import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import path from 'path';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, '..', '..', 'data');
const DB_PATH   = path.join(DATA_DIR, 'state.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

export function tableExists(name: string): boolean {
  const row = getDb().prepare(`
    SELECT 1 AS ok
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(name) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_state (
      chain        TEXT PRIMARY KEY,
      last_block   INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS whitelist_patterns (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT UNIQUE NOT NULL,
      hex_pattern  TEXT NOT NULL,
      pattern_type TEXT NOT NULL DEFAULT 'selector',
      score        INTEGER NOT NULL DEFAULT 1,
      description  TEXT DEFAULT '',
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS seen_selectors (
      hash           TEXT PRIMARY KEY,
      label          TEXT NOT NULL DEFAULT '',
      selectors      TEXT NOT NULL,
      level          INTEGER DEFAULT NULL,
      bytecode_size  INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pattern_sync_state (
      remote_name     TEXT PRIMARY KEY,
      last_pull_at    TEXT DEFAULT NULL,
      last_push_at    TEXT DEFAULT NULL,
      last_verify_at  TEXT DEFAULT NULL,
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key          TEXT PRIMARY KEY,
      value        TEXT NOT NULL DEFAULT '',
      updated_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chain_settings (
      chain                     TEXT PRIMARY KEY,
      blocks_per_scan           INTEGER NOT NULL DEFAULT 12,
      chainbase_keys            TEXT NOT NULL DEFAULT '[]',
      rpc_urls                  TEXT NOT NULL DEFAULT '[]',
      multicall3_address        TEXT NOT NULL DEFAULT '',
      updated_at                TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_audit_providers (
      provider     TEXT PRIMARY KEY,
      enabled      INTEGER NOT NULL DEFAULT 1,
      position     INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_audit_models (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      provider     TEXT NOT NULL,
      model        TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      is_default   INTEGER NOT NULL DEFAULT 0,
      position     INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT DEFAULT (datetime('now')),
      UNIQUE(provider, model)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_audit_models_provider
      ON ai_audit_models (provider, position, id);

    CREATE TABLE IF NOT EXISTS raw_rounds (
      round_id      TEXT PRIMARY KEY,
      chain         TEXT NOT NULL,
      block_from    INTEGER NOT NULL,
      block_to      INTEGER NOT NULL,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS raw_token_transfers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id          TEXT NOT NULL,
      chain             TEXT NOT NULL,
      transaction_hash  TEXT NOT NULL,
      from_address      TEXT,
      to_address        TEXT,
      token_address     TEXT NOT NULL,
      value             TEXT NOT NULL DEFAULT '0',
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_raw_token_transfers_round_chain
      ON raw_token_transfers (round_id, chain);
    CREATE INDEX IF NOT EXISTS idx_raw_token_transfers_chain_token
      ON raw_token_transfers (chain, token_address);

    CREATE TABLE IF NOT EXISTS raw_value_traces (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id          TEXT NOT NULL,
      chain             TEXT NOT NULL,
      transaction_hash  TEXT NOT NULL,
      from_address      TEXT,
      to_address        TEXT,
      value             TEXT NOT NULL DEFAULT '0',
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_raw_value_traces_round_chain
      ON raw_value_traces (round_id, chain);

    CREATE TABLE IF NOT EXISTS tokens_registry (
      id                TEXT PRIMARY KEY,
      chain             TEXT NOT NULL,
      address           TEXT NOT NULL,
      name              TEXT DEFAULT NULL,
      symbol            TEXT DEFAULT NULL,
      decimals          INTEGER DEFAULT NULL,
      token_kind        TEXT DEFAULT NULL,
      price_usd         REAL DEFAULT NULL,
      created           TEXT DEFAULT NULL,
      calls_sync        INTEGER DEFAULT NULL,
      review            TEXT DEFAULT '',
      is_exploitable    INTEGER NOT NULL DEFAULT 0,
      is_auto_audited   INTEGER NOT NULL DEFAULT 0,
      is_manual_audited INTEGER NOT NULL DEFAULT 0,
      is_native         INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT DEFAULT (datetime('now')),
      UNIQUE(chain, address)
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_registry_chain_address
      ON tokens_registry (chain, address);

    CREATE TABLE IF NOT EXISTS contracts_registry (
      id                  TEXT PRIMARY KEY,
      contract_addr       TEXT NOT NULL,
      chain               TEXT NOT NULL,
      deployed_at         TEXT DEFAULT NULL,
      linkage             TEXT DEFAULT NULL,
      link_type           TEXT DEFAULT NULL,
      label               TEXT DEFAULT '',
      review              TEXT DEFAULT '',
      contract_selector_hash TEXT DEFAULT NULL,
      contract_selectors  TEXT NOT NULL DEFAULT '',
      contract_code_size  INTEGER NOT NULL DEFAULT 0,
      selector_hash       TEXT DEFAULT NULL,
      is_exploitable      INTEGER NOT NULL DEFAULT 0,
      portfolio           TEXT NOT NULL DEFAULT '{}',
      is_auto_audit       INTEGER NOT NULL DEFAULT 0,
      is_manual_audit     INTEGER NOT NULL DEFAULT 0,
      whitelist_patterns  TEXT NOT NULL DEFAULT '',
      selectors           TEXT NOT NULL DEFAULT '',
      code_size           INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now')),
      UNIQUE(chain, contract_addr)
    );
    CREATE INDEX IF NOT EXISTS idx_contracts_registry_chain_contract
      ON contracts_registry (chain, contract_addr);
    CREATE INDEX IF NOT EXISTS idx_contracts_registry_selector_hash
      ON contracts_registry (selector_hash);

    CREATE TABLE IF NOT EXISTS ai_audits (
      request_session   TEXT PRIMARY KEY,
      chain             TEXT NOT NULL,
      target_type       TEXT NOT NULL,
      target_addr       TEXT NOT NULL,
      title             TEXT NOT NULL DEFAULT '',
      provider          TEXT NOT NULL DEFAULT '',
      model             TEXT NOT NULL DEFAULT '',
      result_path       TEXT DEFAULT NULL,
      critical          INTEGER DEFAULT NULL,
      high              INTEGER DEFAULT NULL,
      medium            INTEGER DEFAULT NULL,
      is_success        INTEGER DEFAULT NULL,
      requested_at      TEXT NOT NULL DEFAULT (datetime('now')),
      audited_at        TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_audits_chain_target
      ON ai_audits (chain, target_type, target_addr);
    CREATE INDEX IF NOT EXISTS idx_ai_audits_requested_at
      ON ai_audits (requested_at DESC);

    CREATE TABLE IF NOT EXISTS selectors_temp (
      id            TEXT PRIMARY KEY,
      chain         TEXT NOT NULL,
      contract_addr TEXT NOT NULL,
      selector_hash TEXT NOT NULL,
      selectors     TEXT NOT NULL DEFAULT '',
      label         TEXT DEFAULT '',
      bytecode_size INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending',
      last_error    TEXT DEFAULT NULL,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(chain, contract_addr, selector_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_selectors_temp_chain_hash
      ON selectors_temp (chain, selector_hash);

    CREATE TABLE IF NOT EXISTS token_contract_balances (
      id             TEXT PRIMARY KEY,
      chain          TEXT NOT NULL,
      token_address  TEXT NOT NULL,
      contract_addr  TEXT NOT NULL,
      balance        TEXT NOT NULL DEFAULT '0',
      updated_at     TEXT DEFAULT (datetime('now')),
      UNIQUE(chain, token_address, contract_addr)
    );
    CREATE INDEX IF NOT EXISTS idx_token_contract_balances_chain_token
      ON token_contract_balances (chain, token_address);
  `);

  seedWhitelist(db);
  migrateDrop(db);
  ensureTokensRegistrySchema(db);
  migrateTokenMetadataIntoRegistry(db);
  ensureSelectorsTempSchema(db);
  cleanupSelectorsTempRows(db);
  ensureContractsRegistrySchema(db);
  ensureAiAuditSchema(db);
  migrateLegacyContractAiAudits(db);
  ensureRuntimeSettingsSchema(db);
}

function migrateDrop(db: Database.Database): void {
  db.exec(`DROP TABLE IF EXISTS blacklist_addresses;`);
  db.exec(`DROP TABLE IF EXISTS blacklist_patterns;`);
  db.exec(`DROP TABLE IF EXISTS blacklist_pattern_groups;`);
  db.exec(`DROP TABLE IF EXISTS consideration_tokens;`);
  db.exec(`DROP TABLE IF EXISTS pattern_push_queue;`);
  const cols = db.prepare(`PRAGMA table_info(seen_selectors)`).all() as { name: string }[];
  if (cols.some(c => c.name === 'description')) {
    db.exec(`DROP TABLE seen_selectors;`);
  }
  db.exec(`DROP TABLE IF EXISTS seen_contracts;`);
  db.exec(`DROP TABLE IF EXISTS contract_auto_analysis;`);
}

function ensureSelectorsTempSchema(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(selectors_temp)`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'bytecode_size')) {
    db.exec(`ALTER TABLE selectors_temp ADD COLUMN bytecode_size INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!cols.some((col) => col.name === 'status')) {
    db.exec(`ALTER TABLE selectors_temp ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';`);
  }
  if (!cols.some((col) => col.name === 'last_error')) {
    db.exec(`ALTER TABLE selectors_temp ADD COLUMN last_error TEXT DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'updated_at')) {
    db.exec(`ALTER TABLE selectors_temp ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_selectors_temp_status ON selectors_temp (status);`);
}

function cleanupSelectorsTempRows(db: Database.Database): void {
  db.exec(`
    DELETE FROM selectors_temp
    WHERE selectors IS NULL
       OR TRIM(selectors) = ''
       OR status = 'local'
       OR selector_hash IN (SELECT hash FROM seen_selectors)
  `);
}

function ensureTokensRegistrySchema(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(tokens_registry)`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'created')) {
    db.exec(`ALTER TABLE tokens_registry ADD COLUMN created TEXT DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'calls_sync')) {
    db.exec(`ALTER TABLE tokens_registry ADD COLUMN calls_sync INTEGER DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'decimals')) {
    db.exec(`ALTER TABLE tokens_registry ADD COLUMN decimals INTEGER DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'token_kind')) {
    db.exec(`ALTER TABLE tokens_registry ADD COLUMN token_kind TEXT DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'is_auto_audited')) {
    db.exec(`ALTER TABLE tokens_registry ADD COLUMN is_auto_audited INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!cols.some((col) => col.name === 'review')) {
    db.exec(`ALTER TABLE tokens_registry ADD COLUMN review TEXT DEFAULT '';`);
  }
  if (!cols.some((col) => col.name === 'is_exploitable')) {
    db.exec(`ALTER TABLE tokens_registry ADD COLUMN is_exploitable INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!cols.some((col) => col.name === 'is_manual_audited')) {
    db.exec(`ALTER TABLE tokens_registry ADD COLUMN is_manual_audited INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!cols.some((col) => col.name === 'is_native')) {
    db.exec(`ALTER TABLE tokens_registry ADD COLUMN is_native INTEGER NOT NULL DEFAULT 0;`);
  }
}

function ensureAiAuditSchema(db: Database.Database): void {
  let cols = db.prepare(`PRAGMA table_info(ai_audits)`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'request_session')) {
    db.exec(`DROP TABLE IF EXISTS ai_audits;`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_audits (
        request_session   TEXT PRIMARY KEY,
        chain             TEXT NOT NULL,
        target_type       TEXT NOT NULL,
        target_addr       TEXT NOT NULL,
        title             TEXT NOT NULL DEFAULT '',
        provider          TEXT NOT NULL DEFAULT '',
        model             TEXT NOT NULL DEFAULT '',
        result_path       TEXT DEFAULT NULL,
        critical          INTEGER DEFAULT NULL,
        high              INTEGER DEFAULT NULL,
        medium            INTEGER DEFAULT NULL,
        is_success        INTEGER DEFAULT NULL,
        requested_at      TEXT NOT NULL DEFAULT (datetime('now')),
        audited_at        TEXT DEFAULT NULL
      );
    `);
    cols = db.prepare(`PRAGMA table_info(ai_audits)`).all() as Array<{ name: string }>;
  }
  if (!cols.some((col) => col.name === 'target_type')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN target_type TEXT NOT NULL DEFAULT 'contract';`);
  }
  if (!cols.some((col) => col.name === 'target_addr')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN target_addr TEXT NOT NULL DEFAULT '';`);
  }
  if (!cols.some((col) => col.name === 'title')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN title TEXT NOT NULL DEFAULT '';`);
  }
  if (!cols.some((col) => col.name === 'provider')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN provider TEXT NOT NULL DEFAULT '';`);
  }
  if (!cols.some((col) => col.name === 'model')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN model TEXT NOT NULL DEFAULT '';`);
  }
  if (!cols.some((col) => col.name === 'result_path')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN result_path TEXT DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'critical')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN critical INTEGER DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'high')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN high INTEGER DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'medium')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN medium INTEGER DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'is_success')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN is_success INTEGER DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'requested_at')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN requested_at TEXT NOT NULL DEFAULT (datetime('now'));`);
  }
  if (!cols.some((col) => col.name === 'audited_at')) {
    db.exec(`ALTER TABLE ai_audits ADD COLUMN audited_at TEXT DEFAULT NULL;`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_audits_chain_target ON ai_audits (chain, target_type, target_addr);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_audits_requested_at ON ai_audits (requested_at DESC);`);
}

function migrateLegacyContractAiAudits(db: Database.Database): void {
  const legacyTable = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'contract_ai_audits'
    LIMIT 1
  `).get() as { name?: string } | undefined;
  if (!legacyTable?.name) return;

  db.exec(`
    INSERT OR IGNORE INTO ai_audits (
      request_session, chain, target_type, target_addr, title, provider, model, result_path,
      critical, high, medium, is_success, requested_at, audited_at
    )
    SELECT
      request_session,
      chain,
      'contract' AS target_type,
      contract_addr AS target_addr,
      title,
      provider,
      model,
      result_path,
      critical,
      high,
      medium,
      is_success,
      requested_at,
      audited_at
    FROM contract_ai_audits
  `);
}

function ensureRuntimeSettingsSchema(db: Database.Database): void {
  let cols = db.prepare(`PRAGMA table_info(chain_settings)`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'chainbase_keys')) {
    db.exec(`ALTER TABLE chain_settings ADD COLUMN chainbase_keys TEXT NOT NULL DEFAULT '[]';`);
  }
  if (!cols.some((col) => col.name === 'rpc_urls')) {
    db.exec(`ALTER TABLE chain_settings ADD COLUMN rpc_urls TEXT NOT NULL DEFAULT '[]';`);
  }
  if (!cols.some((col) => col.name === 'multicall3_address')) {
    db.exec(`ALTER TABLE chain_settings ADD COLUMN multicall3_address TEXT NOT NULL DEFAULT '';`);
  }
  if (!cols.some((col) => col.name === 'updated_at')) {
    db.exec(`ALTER TABLE chain_settings ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));`);
  }

  cols = db.prepare(`PRAGMA table_info(ai_audit_providers)`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'enabled')) {
    db.exec(`ALTER TABLE ai_audit_providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;`);
  }
  if (!cols.some((col) => col.name === 'position')) {
    db.exec(`ALTER TABLE ai_audit_providers ADD COLUMN position INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!cols.some((col) => col.name === 'updated_at')) {
    db.exec(`ALTER TABLE ai_audit_providers ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));`);
  }

  cols = db.prepare(`PRAGMA table_info(ai_audit_models)`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'enabled')) {
    db.exec(`ALTER TABLE ai_audit_models ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;`);
  }
  if (!cols.some((col) => col.name === 'is_default')) {
    db.exec(`ALTER TABLE ai_audit_models ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!cols.some((col) => col.name === 'position')) {
    db.exec(`ALTER TABLE ai_audit_models ADD COLUMN position INTEGER NOT NULL DEFAULT 0;`);
  }
  if (!cols.some((col) => col.name === 'updated_at')) {
    db.exec(`ALTER TABLE ai_audit_models ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_audit_models_provider ON ai_audit_models (provider, position, id);`);
}

function migrateTokenMetadataIntoRegistry(db: Database.Database): void {
  const hasTokenMetadata = db.prepare(`
    SELECT 1 AS ok
    FROM sqlite_master
    WHERE type = 'table' AND name = 'token_metadata'
    LIMIT 1
  `).get() as { ok: number } | undefined;
  if (!hasTokenMetadata?.ok) return;

  const tokenMetadataCols = db.prepare(`PRAGMA table_info(token_metadata)`).all() as Array<{ name: string }>;
  const hasCol = (name: string) => tokenMetadataCols.some((col) => col.name === name);
  const rows = db.prepare(`
    SELECT
      chain,
      token,
      ${hasCol('name') ? 'name' : 'NULL AS name'},
      ${hasCol('symbol') ? 'symbol' : 'NULL AS symbol'},
      ${hasCol('decimals') ? 'decimals' : 'NULL AS decimals'},
      ${hasCol('token_kind') ? 'token_kind' : 'NULL AS token_kind'},
      ${hasCol('token_price_usd') ? 'token_price_usd' : 'NULL AS token_price_usd'},
      ${hasCol('is_auto_audited') ? 'is_auto_audited' : '0 AS is_auto_audited'},
      ${hasCol('is_manual_audited') ? 'is_manual_audited' : '0 AS is_manual_audited'},
      ${hasCol('is_native') ? 'is_native' : '0 AS is_native'},
      ${hasCol('token_created_at') ? 'token_created_at' : 'NULL AS token_created_at'},
      ${hasCol('token_calls_sync') ? 'token_calls_sync' : 'NULL AS token_calls_sync'}
    FROM token_metadata
    ORDER BY chain ASC, token ASC
  `).all() as Array<{
    chain: string;
    token: string;
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    token_kind: string | null;
    token_price_usd: number | null;
    is_auto_audited: number;
    is_manual_audited: number;
    is_native: number;
    token_created_at: string | null;
    token_calls_sync: number | null;
  }>;

  if (rows.length) {
    const upsert = db.prepare(`
      INSERT INTO tokens_registry (
        id, chain, address, name, symbol, decimals, token_kind, price_usd, created, calls_sync,
        is_auto_audited, is_manual_audited, is_native, updated_at
      ) VALUES (
        @id, @chain, @address, @name, @symbol, @decimals, @token_kind, @price_usd, @created, @calls_sync,
        @is_auto_audited, @is_manual_audited, @is_native, datetime('now')
      )
      ON CONFLICT(chain, address) DO UPDATE SET
        name = COALESCE(tokens_registry.name, excluded.name),
        symbol = COALESCE(tokens_registry.symbol, excluded.symbol),
        decimals = COALESCE(tokens_registry.decimals, excluded.decimals),
        token_kind = COALESCE(tokens_registry.token_kind, excluded.token_kind),
        price_usd = COALESCE(tokens_registry.price_usd, excluded.price_usd),
        created = COALESCE(tokens_registry.created, excluded.created),
        calls_sync = COALESCE(tokens_registry.calls_sync, excluded.calls_sync),
        is_auto_audited = CASE
          WHEN tokens_registry.is_auto_audited = 1 OR excluded.is_auto_audited = 1 THEN 1
          ELSE 0
        END,
        is_manual_audited = CASE
          WHEN tokens_registry.is_manual_audited = 1 OR excluded.is_manual_audited = 1 THEN 1
          ELSE 0
        END,
        is_native = CASE
          WHEN tokens_registry.is_native = 1 OR excluded.is_native = 1 THEN 1
          ELSE 0
        END,
        updated_at = datetime('now')
    `);

    const run = db.transaction((entries: typeof rows) => {
      for (const row of entries) {
        const chain = row.chain.toLowerCase();
        const address = row.token.toLowerCase();
        upsert.run({
          id: v2Id('token', `${chain}:${address}`),
          chain,
          address,
          name: row.name,
          symbol: row.symbol,
          decimals: row.decimals,
          token_kind: row.token_kind,
          price_usd: row.token_price_usd,
          created: row.token_created_at,
          calls_sync: row.token_calls_sync,
          is_auto_audited: row.is_auto_audited ? 1 : 0,
          is_manual_audited: row.is_manual_audited ? 1 : 0,
          is_native: row.is_native ? 1 : 0,
        });
      }
    });
    run(rows);
  }

  db.exec(`DROP TABLE IF EXISTS token_metadata;`);
}

function ensureContractsRegistrySchema(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(contracts_registry)`).all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'deployed_at')) {
    db.exec(`ALTER TABLE contracts_registry ADD COLUMN deployed_at TEXT DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'contract_selector_hash')) {
    db.exec(`ALTER TABLE contracts_registry ADD COLUMN contract_selector_hash TEXT DEFAULT NULL;`);
  }
  if (!cols.some((col) => col.name === 'contract_selectors')) {
    db.exec(`ALTER TABLE contracts_registry ADD COLUMN contract_selectors TEXT NOT NULL DEFAULT '';`);
  }
  if (!cols.some((col) => col.name === 'contract_code_size')) {
    db.exec(`ALTER TABLE contracts_registry ADD COLUMN contract_code_size INTEGER NOT NULL DEFAULT 0;`);
  }
}

function seedWhitelist(db: Database.Database): void {
  const wlInsert = db.prepare(`
    INSERT OR IGNORE INTO whitelist_patterns (name, hex_pattern, pattern_type, score, description)
    VALUES (@name, @hex_pattern, @pattern_type, @score, @description)
  `);
  const defaults = [
    { name: 'multicall',       hex_pattern: 'ac9650d8', pattern_type: 'selector', score: 3, description: 'multicall() - has batch call' },
    { name: 'univ2_call',      hex_pattern: '10d1e85c', pattern_type: 'selector', score: 4, description: 'uniswapV2Call() - has flash callback' },
    { name: 'pancake_call',    hex_pattern: '84800812', pattern_type: 'selector', score: 4, description: 'pancakeCall() - has flash callback' },
    { name: 'execute_op',      hex_pattern: 'b61d27f6', pattern_type: 'selector', score: 3, description: 'execute() - has generic proxy call' },
    { name: 'get_amounts_out', hex_pattern: 'd06ca61f', pattern_type: 'call',     score: 2, description: 'calls getAmountsOut() - V2 oracle dep' },
    { name: 'get_reserves',    hex_pattern: '0902f1ac', pattern_type: 'call',     score: 1, description: 'calls getReserves() - V2 oracle dep' },
    { name: 'slot0',           hex_pattern: '3850c7bd', pattern_type: 'call',     score: 2, description: 'calls slot0() - V3 oracle dep' },
    { name: 'flash_loan',      hex_pattern: 'ab9c4b5d', pattern_type: 'call',     score: 6, description: 'calls flashLoan()' },
    { name: 'flash_loan_aave', hex_pattern: '42b0b77c', pattern_type: 'call',     score: 6, description: 'calls flashLoan() Aave' },
  ];
  for (const p of defaults) wlInsert.run(p);
}

export function v2Id(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}

export async function backupDatabaseToFile(filePath: string): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  await getDb().backup(filePath);
}

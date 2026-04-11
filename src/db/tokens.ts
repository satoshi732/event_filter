import { getDb, v2Id } from './core.js';
import { LegacyTokenMetadataRow, TokenMetadataCacheRow, TokenRegistryRow } from './types.js';
import { sanitizeTokenPriceUsd } from '../utils/token-price.js';

export function getTokenMetadataCache(chain: string, tokens: string[]): Map<string, TokenMetadataCacheRow> {
  const normalized = [...new Set(tokens.map(token => token.toLowerCase()).filter(Boolean))];
  if (!normalized.length) return new Map();

  const placeholders = normalized.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT address AS token, name, symbol, decimals, price_usd, is_auto_audited, is_manual_audited, is_native, created, calls_sync, token_kind
    FROM tokens_registry
    WHERE chain = ?
      AND address IN (${placeholders})
  `).all(chain.toLowerCase(), ...normalized) as Array<{
    token: string;
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    price_usd: number | null;
    is_auto_audited: number;
    is_manual_audited: number;
    token_kind: string | null;
    is_native: number;
    created: string | null;
    calls_sync: number | null;
  }>;

  return new Map(rows.map((row) => [
    row.token.toLowerCase(),
    {
      token: row.token.toLowerCase(),
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals,
      tokenPriceUsd: sanitizeTokenPriceUsd(row.price_usd),
      tokenKind: (row.token_kind as TokenMetadataCacheRow['tokenKind']) ?? null,
      isAutoAudited: Boolean(row.is_auto_audited),
      isManualAudited: Boolean(row.is_manual_audited),
      is_native: Boolean(row.is_native),
      tokenCreatedAt: row.created ?? null,
      tokenCallsSync: row.calls_sync == null ? null : Boolean(row.calls_sync),
    },
  ]));
}

export function getTokensMissingPrice(chain: string, limit = 300): string[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 300;
  const rows = getDb().prepare(`
    SELECT address AS token
    FROM tokens_registry
    WHERE chain = ?
      AND price_usd IS NULL
      AND COALESCE(token_kind, 'fungible') NOT IN ('erc721', 'erc1155')
    ORDER BY updated_at ASC, address ASC
    LIMIT ?
  `).all(chain.toLowerCase(), safeLimit) as Array<{ token: string }>;
  return rows.map((row) => row.token.toLowerCase());
}

export function upsertTokenMetadataBatch(
  chain: string,
  rows: Array<{
    token: string;
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    tokenPriceUsd?: number | null;
    tokenKind?: TokenMetadataCacheRow['tokenKind'];
    isAutoAudited?: boolean;
    isManualAudited?: boolean;
    is_native?: boolean;
  }>,
): void {
  if (!rows.length) return;

  const insert = getDb().prepare(`
    INSERT INTO tokens_registry (
      id, chain, address, name, symbol, decimals, token_kind, price_usd,
      is_auto_audited, is_manual_audited, is_native, updated_at
    )
    VALUES (
      @id, @chain, @address, @name, @symbol, @decimals, @token_kind, @price_usd,
      @is_auto_audited, @is_manual_audited, @is_native, datetime('now')
    )
    ON CONFLICT(chain, address) DO UPDATE SET
      name = CASE WHEN excluded.name IS NOT NULL THEN excluded.name ELSE tokens_registry.name END,
      symbol = CASE WHEN excluded.symbol IS NOT NULL THEN excluded.symbol ELSE tokens_registry.symbol END,
      decimals = CASE WHEN excluded.decimals IS NOT NULL THEN excluded.decimals ELSE tokens_registry.decimals END,
      token_kind = COALESCE(excluded.token_kind, tokens_registry.token_kind),
      price_usd = CASE
        WHEN excluded.price_usd IS NOT NULL THEN excluded.price_usd
        ELSE tokens_registry.price_usd
      END,
      is_auto_audited = CASE
        WHEN excluded.is_auto_audited = 1 THEN 1
        ELSE tokens_registry.is_auto_audited
      END,
      is_manual_audited = CASE
        WHEN excluded.is_manual_audited = 1 THEN 1
        ELSE tokens_registry.is_manual_audited
      END,
      is_native = CASE
        WHEN excluded.is_native = 1 THEN 1
        ELSE tokens_registry.is_native
      END,
      updated_at = datetime('now')
  `);

  const run = getDb().transaction((entries: typeof rows) => {
    for (const row of entries) {
      insert.run({
        id: v2Id('token', `${chain.toLowerCase()}:${row.token.toLowerCase()}`),
        chain: chain.toLowerCase(),
        address: row.token.toLowerCase(),
        name: row.name,
        symbol: row.symbol,
        decimals: row.decimals,
        token_kind: row.tokenKind ?? null,
        price_usd: sanitizeTokenPriceUsd(row.tokenPriceUsd ?? null),
        is_auto_audited: row.isAutoAudited ? 1 : 0,
        is_manual_audited: row.isManualAudited ? 1 : 0,
        is_native: row.is_native ? 1 : 0,
      });
    }
  });

  run(rows);
}

export function upsertTokenPriceBatch(
  chain: string,
  rows: Array<{
    token: string;
    tokenPriceUsd: number;
  }>,
): void {
  if (!rows.length) return;

  const normalizedRows = rows
    .map((row) => ({
      token: row.token.toLowerCase(),
      tokenPriceUsd: sanitizeTokenPriceUsd(row.tokenPriceUsd),
    }))
    .filter((row) => row.token && row.tokenPriceUsd != null);

  if (!normalizedRows.length) return;

  const insert = getDb().prepare(`
    INSERT INTO tokens_registry (id, chain, address, price_usd, updated_at)
    VALUES (@id, @chain, @address, @price_usd, datetime('now'))
    ON CONFLICT(chain, address) DO UPDATE SET
      price_usd = excluded.price_usd,
      updated_at = datetime('now')
  `);

  const run = getDb().transaction((entries: typeof normalizedRows) => {
    for (const row of entries) {
      insert.run({
        id: v2Id('token', `${chain.toLowerCase()}:${row.token}`),
        chain: chain.toLowerCase(),
        address: row.token,
        price_usd: row.tokenPriceUsd,
      });
    }
  });

  run(normalizedRows);
}

export function upsertTokenContractFactsBatch(
  chain: string,
  rows: Array<{
    token: string;
    tokenCreatedAt: string | null;
    tokenCallsSync: boolean | null;
    is_native?: boolean;
  }>,
): void {
  if (!rows.length) return;

  const insert = getDb().prepare(`
    INSERT INTO tokens_registry (
      id, chain, address, is_native, created, calls_sync, updated_at
    )
    VALUES (@id, @chain, @address, @is_native, @created, @calls_sync, datetime('now'))
    ON CONFLICT(chain, address) DO UPDATE SET
      is_native = CASE
        WHEN excluded.is_native = 1 THEN 1
        ELSE tokens_registry.is_native
      END,
      created = excluded.created,
      calls_sync = excluded.calls_sync,
      updated_at = datetime('now')
  `);

  const run = getDb().transaction((entries: typeof rows) => {
    for (const row of entries) {
      insert.run({
        id: v2Id('token', `${chain.toLowerCase()}:${row.token.toLowerCase()}`),
        chain: chain.toLowerCase(),
        address: row.token.toLowerCase(),
        is_native: row.is_native ? 1 : 0,
        created: row.tokenCreatedAt,
        calls_sync: row.tokenCallsSync == null ? null : (row.tokenCallsSync ? 1 : 0),
      });
    }
  });

  run(rows);
}

export function upsertTokenMetadataAuditBatch(
  chain: string,
  rows: Array<{
    token: string;
    isAutoAudited?: boolean;
    isManualAudited?: boolean;
  }>,
): void {
  if (!rows.length) return;

  const insert = getDb().prepare(`
    INSERT INTO tokens_registry (
      id, chain, address, is_auto_audited, is_manual_audited, updated_at
    )
    VALUES (@id, @chain, @address, @is_auto_audited, @is_manual_audited, datetime('now'))
    ON CONFLICT(chain, address) DO UPDATE SET
      is_auto_audited = CASE
        WHEN excluded.is_auto_audited = 1 THEN 1
        ELSE tokens_registry.is_auto_audited
      END,
      is_manual_audited = CASE
        WHEN excluded.is_manual_audited = 1 THEN 1
        ELSE tokens_registry.is_manual_audited
      END,
      updated_at = datetime('now')
  `);

  const run = getDb().transaction((entries: typeof rows) => {
    for (const row of entries) {
      insert.run({
        id: v2Id('token', `${chain.toLowerCase()}:${row.token.toLowerCase()}`),
        chain: chain.toLowerCase(),
        address: row.token.toLowerCase(),
        is_auto_audited: row.isAutoAudited ? 1 : 0,
        is_manual_audited: row.isManualAudited ? 1 : 0,
      });
    }
  });

  run(rows);
}

export function getTokenRegistry(chain: string, addresses: string[]): Map<string, TokenRegistryRow> {
  const normalized = [...new Set(addresses.map((value) => value.toLowerCase()).filter(Boolean))];
  if (!normalized.length) return new Map();

  const placeholders = normalized.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT
      id, chain, address, name, symbol, price_usd, created, calls_sync, review, is_exploitable,
      decimals, token_kind, is_auto_audited, is_manual_audited, is_native, updated_at
    FROM tokens_registry
    WHERE chain = ?
      AND address IN (${placeholders})
  `).all(chain.toLowerCase(), ...normalized) as Array<{
    id: string;
    chain: string;
    address: string;
    name: string | null;
    symbol: string | null;
    price_usd: number | null;
    created: string | null;
    calls_sync: number | null;
    review: string | null;
    is_exploitable: number;
    decimals: number | null;
    token_kind: string | null;
    is_auto_audited: number;
    is_manual_audited: number;
    is_native: number;
    updated_at: string;
  }>;

  return new Map(rows.map((row) => [
    row.address.toLowerCase(),
    {
      id: row.id,
      chain: row.chain,
      address: row.address.toLowerCase(),
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals ?? null,
      tokenKind: (row.token_kind as TokenRegistryRow['tokenKind']) ?? null,
      priceUsd: sanitizeTokenPriceUsd(row.price_usd),
      created: row.created ?? null,
      callsSync: row.calls_sync == null ? null : Boolean(row.calls_sync),
      review: row.review ?? '',
      isExploitable: Boolean(row.is_exploitable),
      isAutoAudited: Boolean(row.is_auto_audited),
      isManualAudited: Boolean(row.is_manual_audited),
      isNative: Boolean(row.is_native),
      updatedAt: row.updated_at,
    },
  ]));
}

export function upsertTokenRegistryBatch(
  chain: string,
  rows: Array<{
    address: string;
    name: string | null;
    symbol: string | null;
    decimals?: number | null;
    tokenKind?: TokenMetadataCacheRow['tokenKind'];
    priceUsd: number | null;
    created: string | null;
    callsSync: boolean | null;
    isAutoAudited?: boolean;
    isManualAudited?: boolean;
    isNative?: boolean;
  }>,
): void {
  if (!rows.length) return;
  const chainName = chain.toLowerCase();
  const insert = getDb().prepare(`
    INSERT INTO tokens_registry (
      id, chain, address, name, symbol, decimals, token_kind, price_usd, created, calls_sync, review, is_exploitable,
      is_auto_audited, is_manual_audited, is_native, updated_at
    ) VALUES (
      @id, @chain, @address, @name, @symbol, @decimals, @token_kind, @price_usd, @created, @calls_sync, @review, @is_exploitable,
      @is_auto_audited, @is_manual_audited, @is_native, datetime('now')
    )
    ON CONFLICT(chain, address) DO UPDATE SET
      name = CASE WHEN excluded.name IS NOT NULL THEN excluded.name ELSE tokens_registry.name END,
      symbol = CASE WHEN excluded.symbol IS NOT NULL THEN excluded.symbol ELSE tokens_registry.symbol END,
      decimals = CASE WHEN excluded.decimals IS NOT NULL THEN excluded.decimals ELSE tokens_registry.decimals END,
      token_kind = CASE WHEN excluded.token_kind IS NOT NULL THEN excluded.token_kind ELSE tokens_registry.token_kind END,
      price_usd = CASE WHEN excluded.price_usd IS NOT NULL THEN excluded.price_usd ELSE tokens_registry.price_usd END,
      created = CASE WHEN excluded.created IS NOT NULL THEN excluded.created ELSE tokens_registry.created END,
      calls_sync = CASE WHEN excluded.calls_sync IS NOT NULL THEN excluded.calls_sync ELSE tokens_registry.calls_sync END,
      review = CASE WHEN excluded.review != '' THEN excluded.review ELSE tokens_registry.review END,
      is_exploitable = CASE
        WHEN excluded.is_exploitable = 1 THEN 1
        ELSE tokens_registry.is_exploitable
      END,
      is_auto_audited = CASE
        WHEN excluded.is_auto_audited = 1 THEN 1
        ELSE tokens_registry.is_auto_audited
      END,
      is_manual_audited = CASE
        WHEN excluded.is_manual_audited = 1 THEN 1
        ELSE tokens_registry.is_manual_audited
      END,
      is_native = CASE
        WHEN excluded.is_native = 1 THEN 1
        ELSE tokens_registry.is_native
      END,
      updated_at = datetime('now')
  `);

  const run = getDb().transaction((entries: typeof rows) => {
    for (const row of entries) {
      const address = row.address.toLowerCase();
      insert.run({
        id: v2Id('token', `${chainName}:${address}`),
        chain: chainName,
        address,
        name: row.name,
        symbol: row.symbol,
        decimals: row.decimals ?? null,
        token_kind: row.tokenKind ?? null,
        price_usd: sanitizeTokenPriceUsd(row.priceUsd),
        created: row.created,
        calls_sync: row.callsSync == null ? null : (row.callsSync ? 1 : 0),
        review: '',
        is_exploitable: 0,
        is_auto_audited: row.isAutoAudited ? 1 : 0,
        is_manual_audited: row.isManualAudited ? 1 : 0,
        is_native: row.isNative ? 1 : 0,
      });
    }
  });

  run(rows);
}

export function saveTokenManualReview(input: {
  chain: string;
  token: string;
  reviewText: string;
  exploitable: boolean;
}): TokenRegistryRow {
  const chainName = input.chain.toLowerCase();
  const token = input.token.toLowerCase();
  const review = String(input.reviewText || '').trim();
  const exploitable = Boolean(input.exploitable);

  getDb().prepare(`
    INSERT INTO tokens_registry (
      id, chain, address, review, is_exploitable, is_manual_audited, updated_at
    ) VALUES (
      @id, @chain, @address, @review, @is_exploitable, 1, datetime('now')
    )
    ON CONFLICT(chain, address) DO UPDATE SET
      review = excluded.review,
      is_exploitable = excluded.is_exploitable,
      is_manual_audited = 1,
      updated_at = datetime('now')
  `).run({
    id: v2Id('token', `${chainName}:${token}`),
    chain: chainName,
    address: token,
    review,
    is_exploitable: exploitable ? 1 : 0,
  });

  return getTokenRegistry(chainName, [token]).get(token)!;
}

export function upsertTokenContractBalanceBatch(
  chain: string,
  rows: Array<{
    tokenAddress: string;
    contractAddr: string;
    balance: string;
  }>,
): void {
  if (!rows.length) return;
  const chainName = chain.toLowerCase();
  const insert = getDb().prepare(`
    INSERT INTO token_contract_balances (
      id, chain, token_address, contract_addr, balance, updated_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(chain, token_address, contract_addr) DO UPDATE SET
      balance = excluded.balance,
      updated_at = datetime('now')
  `);
  const run = getDb().transaction((entries: typeof rows) => {
    for (const row of entries) {
      const token = row.tokenAddress.toLowerCase();
      const contract = row.contractAddr.toLowerCase();
      insert.run(
        v2Id('token-balance', `${chainName}:${token}:${contract}`),
        chainName,
        token,
        contract,
        row.balance ?? '0',
      );
    }
  });
  run(rows);
}

export function getAllLegacyTokenMetadataRows(): LegacyTokenMetadataRow[] {
  const rows = getDb().prepare(`
    SELECT
      chain, address, name, symbol, token_kind, price_usd, review, is_exploitable, is_auto_audited, is_manual_audited, is_native, created, calls_sync
    FROM tokens_registry
    ORDER BY chain ASC, address ASC
  `).all() as Array<{
    chain: string;
    address: string;
    name: string | null;
    symbol: string | null;
    token_kind: string | null;
    price_usd: number | null;
    review: string | null;
    is_exploitable: number;
    is_auto_audited: number;
    is_manual_audited: number;
    is_native: number;
    created: string | null;
    calls_sync: number | null;
  }>;

  return rows.map((row) => ({
    chain: row.chain.toLowerCase(),
    token: row.address.toLowerCase(),
    name: row.name,
    symbol: row.symbol,
    tokenKind: (row.token_kind as TokenMetadataCacheRow['tokenKind']) ?? null,
    tokenPriceUsd: sanitizeTokenPriceUsd(row.price_usd),
    review: row.review ?? '',
    isExploitable: Boolean(row.is_exploitable),
    isAutoAudited: Boolean(row.is_auto_audited),
    isManualAudited: Boolean(row.is_manual_audited),
    isNative: Boolean(row.is_native),
    tokenCreatedAt: row.created ?? null,
    tokenCallsSync: row.calls_sync == null ? null : Boolean(row.calls_sync),
  }));
}

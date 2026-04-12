import { createHash } from 'crypto';
import { getDb, tableExists, v2Id } from './core.js';
import {
  ContractRegistryRow,
  LegacySeenContractRow,
  PatternPushQueueRow,
  PatternSyncStateRow,
  SeenContractRow,
  SeenSelectorEntry,
  SelectorTempReviewTarget,
} from './types.js';
import { getContractsRegistry, upsertContractsRegistryBatch } from './contracts.js';

export function addSeenSelectors(
  selectors: string[],
  label: string,
  bytecodeSize = 0,
  level: number | null = null,
): string {
  const sorted = [...new Set(selectors)].sort().join(',');
  const hash = createHash('sha256').update(sorted).digest('hex');
  getDb().prepare(`
    INSERT OR REPLACE INTO seen_selectors (hash, label, selectors, level, bytecode_size)
    VALUES (?, ?, ?, ?, ?)
  `).run(hash, label, sorted, level, bytecodeSize);
  return hash;
}

export function getSeenSelectorEntries(): SeenSelectorEntry[] {
  const rows = getDb().prepare(
    'SELECT hash, label, selectors, level, bytecode_size FROM seen_selectors',
  ).all() as { hash: string; label: string; selectors: string; level: number | null; bytecode_size: number }[];
  return rows.map(r => ({
    hash: r.hash,
    label: r.label || '(unnamed)',
    selectors: new Set(r.selectors.split(',')),
    level: r.level,
    bytecodeSize: r.bytecode_size ?? 0,
  }));
}

export function removeSeenSelector(hash: string): boolean {
  const r = getDb().prepare('DELETE FROM seen_selectors WHERE hash = ?').run(hash);
  return r.changes > 0;
}

export function listSeenSelectors(): SeenSelectorEntry[] {
  return getSeenSelectorEntries();
}

export function findSelectorTempReviewTarget(
  chain: string,
  address: string,
  targetKind = 'auto',
): SelectorTempReviewTarget | null {
  const chainName = chain.toLowerCase();
  const targetAddress = address.toLowerCase();
  const requestedKind = targetKind.toLowerCase();
  const rows = getDb().prepare(`
    SELECT
      cr.contract_addr AS owner_address,
      cr.link_type AS link_type,
      cr.linkage AS linkage,
      cr.contract_selector_hash AS contract_selector_hash,
      cr.contract_selectors AS contract_selectors,
      cr.contract_code_size AS contract_code_size,
      cr.selector_hash AS selector_hash,
      cr.selectors AS selectors,
      cr.code_size AS code_size
    FROM contracts_registry cr
    WHERE cr.chain = ?
      AND (
        cr.contract_addr = ?
        OR COALESCE(cr.linkage, '') = ?
      )
    ORDER BY cr.updated_at DESC, cr.created_at DESC
  `).all(chainName, targetAddress, targetAddress) as Array<{
    owner_address: string;
    link_type: string | null;
    linkage: string | null;
    contract_selector_hash: string | null;
    contract_selectors: string;
    contract_code_size: number;
    selector_hash: string | null;
    selectors: string;
    code_size: number;
  }>;

  if (!rows.length) return null;

  const tempRows = getDb().prepare(`
    SELECT contract_addr, selector_hash, selectors, bytecode_size
    FROM selectors_temp
    WHERE chain = ?
      AND contract_addr IN (${rows.map(() => '?').join(', ')})
  `).all(chainName, ...rows.map((row) => row.owner_address.toLowerCase())) as Array<{
    contract_addr: string;
    selector_hash: string;
    selectors: string;
    bytecode_size: number;
  }>;
  const tempMap = new Map<string, { selectors: string[]; bytecodeSize: number }>();
  for (const row of tempRows) {
    tempMap.set(
      `${row.contract_addr.toLowerCase()}:${row.selector_hash}`,
      {
        selectors: row.selectors.split(',').filter(Boolean),
        bytecodeSize: row.bytecode_size ?? 0,
      },
    );
  }

  const normalizedRows: SelectorTempReviewTarget[] = [];
  for (const row of rows) {
    const ownerAddress = row.owner_address.toLowerCase();
    const contractHash = row.contract_selector_hash ?? (row.link_type ? null : row.selector_hash);
    const contractTemp = contractHash ? tempMap.get(`${ownerAddress}:${contractHash}`) : null;
    const contractSelectors = contractTemp?.selectors
      ?? (row.contract_selectors ? row.contract_selectors.split(',').filter(Boolean) : [])
      ?? [];
    const contractCodeSize = contractTemp?.bytecodeSize
      ?? row.contract_code_size
      ?? 0;

    if (contractHash && contractSelectors.length > 0) {
      normalizedRows.push({
        ownerAddress,
        targetAddress: ownerAddress,
        targetKind: 'contract',
        patternHash: contractHash,
        selectors: contractSelectors,
        bytecodeSize: contractCodeSize,
      });
    }

    const effectiveKind = row.link_type === 'proxy'
      ? 'implementation'
      : (row.link_type === 'eip7702' ? 'delegate' : null);
    const effectiveTargetAddress = row.linkage?.toLowerCase() ?? ownerAddress;
    const effectiveHash = row.selector_hash;
    const effectiveTemp = effectiveHash ? tempMap.get(`${ownerAddress}:${effectiveHash}`) : null;
    const effectiveSelectors = effectiveTemp?.selectors
      ?? row.selectors.split(',').filter(Boolean);
    const effectiveCodeSize = effectiveTemp?.bytecodeSize
      ?? row.code_size
      ?? 0;

    if (effectiveKind && effectiveHash && effectiveSelectors.length > 0) {
      normalizedRows.push({
        ownerAddress,
        targetAddress: effectiveTargetAddress,
        targetKind: effectiveKind,
        patternHash: effectiveHash,
        selectors: effectiveSelectors,
        bytecodeSize: effectiveCodeSize,
      });
    }
  }

  const matchesKind = (row: SelectorTempReviewTarget): boolean => (
    requestedKind === 'auto' || row.targetKind === requestedKind
  );

  return normalizedRows.find((row) => matchesKind(row) && row.ownerAddress === targetAddress)
    ?? normalizedRows.find((row) => matchesKind(row) && row.targetAddress === targetAddress)
    ?? (requestedKind === 'auto' ? normalizedRows[0] : null);
}

export function upsertSeenContractReview(input: {
  chain: string;
  contractAddress: string;
  patternHash: string;
  patternKind: string;
  patternAddress: string;
  label: string;
  reviewText?: string;
  exploitable?: boolean;
  selectors: string[];
  bytecodeSize?: number;
}): void {
  const chain = input.chain.toLowerCase();
  const contractAddress = input.contractAddress.toLowerCase();
  const patternHash = input.patternHash;
  const patternKind = input.patternKind;
  const patternAddress = input.patternAddress.toLowerCase();
  const selectors = [...new Set(input.selectors.map((value) => value.toLowerCase()))].sort();
  const bytecodeSize = input.bytecodeSize ?? 0;
  const syncStatus = 'prepared';
  const existing = getContractsRegistry(chain, [contractAddress]).get(contractAddress);

  if (selectors.length > 0) {
    upsertSelectorsTempBatch(chain, [{
      contractAddr: contractAddress,
      selectorHash: patternHash,
      selectors,
      label: input.label,
      bytecodeSize,
      status: syncStatus,
      lastError: null,
    }]);
  }

  const requestedLinkType: 'proxy' | 'eip7702' | null = patternKind === 'implementation'
    ? 'proxy'
    : (patternKind === 'delegate' ? 'eip7702' : null);
  const nextLinkType = requestedLinkType ?? existing?.linkType ?? null;
  const linkage = requestedLinkType
    ? patternAddress
    : (existing?.linkage ?? null);
  const contractSelectorHash = patternKind === 'contract'
    ? patternHash
    : (existing?.contractSelectorHash ?? null);
  const contractSelectors = patternKind === 'contract'
    ? selectors
    : (existing?.contractSelectors ?? []);
  const contractCodeSize = patternKind === 'contract'
    ? bytecodeSize
    : (existing?.contractCodeSize ?? 0);
  const effectiveSelectorHash = patternKind === 'contract'
    ? (nextLinkType ? (existing?.selectorHash ?? null) : patternHash)
    : patternHash;
  const effectiveSelectors = patternKind === 'contract'
    ? (nextLinkType ? (existing?.selectors ?? []) : selectors)
    : selectors;
  const effectiveCodeSize = patternKind === 'contract'
    ? (nextLinkType ? (existing?.codeSize ?? 0) : bytecodeSize)
    : bytecodeSize;

  upsertContractsRegistryBatch(chain, [{
    contractAddr: contractAddress,
    linkage,
    linkType: nextLinkType,
    label: input.label,
    review: input.reviewText ?? '',
    contractSelectorHash,
    contractSelectors,
    contractCodeSize,
    selectorHash: effectiveSelectorHash,
    isExploitable: Boolean(input.exploitable),
    portfolio: '{}',
    isAutoAudit: false,
    isManualAudit: true,
    whitelistPatterns: [],
    selectors: effectiveSelectors,
    codeSize: effectiveCodeSize,
  }]);
}

function mapSeenContractRow(row: {
  id: string;
  chain: string;
  contract_address: string;
  pattern_hash: string;
  pattern_kind: string;
  pattern_address: string;
  label: string;
  review_text: string;
  exploitable: number;
  selectors: string;
  bytecode_size: number;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}): SeenContractRow {
  const numericId = Number.parseInt((row.id ?? '').slice(0, 12), 16);
  return {
    id: Number.isFinite(numericId) ? numericId : 0,
    chain: row.chain,
    contractAddress: row.contract_address,
    patternHash: row.pattern_hash,
    patternKind: row.pattern_kind,
    patternAddress: row.pattern_address,
    label: row.label,
    reviewText: row.review_text ?? '',
    exploitable: Boolean(row.exploitable),
    selectors: row.selectors.split(',').filter(Boolean),
    bytecodeSize: row.bytecode_size ?? 0,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getSeenContractsForPush(statuses?: string[]): PatternPushQueueRow[] {
  const where = statuses?.length
    ? `WHERE status IN (${statuses.map(() => '?').join(', ')}) AND label != '' AND selectors != ''`
    : `WHERE label != '' AND selectors != ''`;
  const rows = getDb().prepare(`
    SELECT
      selector_hash AS hash,
      MAX(CASE WHEN label != '' THEN label ELSE '' END) AS label,
      MAX(selectors) AS selectors,
      MAX(bytecode_size) AS bytecode_size,
      MIN(status) AS status,
      MIN(last_error) AS last_error,
      MIN(created_at) AS created_at,
      MAX(updated_at) AS updated_at
    FROM selectors_temp
    ${where}
    GROUP BY selector_hash
    ORDER BY MIN(created_at) ASC
  `).all(...(statuses ?? [])) as Array<{
    hash: string;
    label: string;
    selectors: string;
    bytecode_size: number;
    status: string;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    hash: row.hash,
    label: row.label,
    selectors: row.selectors.split(',').filter(Boolean),
    bytecodeSize: row.bytecode_size ?? 0,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function markSeenContractPushResult(
  hash: string,
  status: 'synced' | 'failed',
  lastError: string | null = null,
): void {
  if (status === 'synced') {
    getDb().prepare(`
      DELETE FROM selectors_temp
      WHERE selector_hash = ?
        AND status = 'prepared'
    `).run(hash);
    return;
  }

  getDb().prepare(`
    UPDATE selectors_temp
    SET status = 'prepared', last_error = ?, updated_at = datetime('now')
    WHERE selector_hash = ?
  `).run(lastError, hash);
}

export function getSeenContractQueueCounts(): Record<string, number> {
  const rows = getDb().prepare(`
    SELECT status, COUNT(*) AS count
    FROM selectors_temp
    GROUP BY status
  `).all() as Array<{ status: string; count: number }>;

  const out: Record<string, number> = {};
  rows.forEach((row) => {
    out[row.status] = row.count;
  });
  return out;
}

export function getSeenContractReviewsByPatternHashes(hashes: string[]): Map<string, SeenContractRow[]> {
  const normalized = [...new Set(hashes.filter(Boolean))];
  if (!normalized.length) return new Map();

  const placeholders = normalized.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT
      cr.id AS id,
      cr.chain AS chain,
      cr.contract_addr AS contract_address,
      COALESCE(cr.contract_selector_hash, CASE WHEN cr.link_type IS NULL THEN cr.selector_hash ELSE NULL END) AS pattern_hash,
      'contract' AS pattern_kind,
      cr.contract_addr AS pattern_address,
      cr.label AS label,
      cr.review AS review_text,
      cr.is_exploitable AS exploitable,
      COALESCE(NULLIF(cr.contract_selectors, ''), st_contract.selectors, CASE WHEN cr.link_type IS NULL THEN cr.selectors ELSE '' END) AS selectors,
      COALESCE(st_contract.bytecode_size, cr.contract_code_size, CASE WHEN cr.link_type IS NULL THEN cr.code_size ELSE 0 END) AS bytecode_size,
      COALESCE(st_contract.status, 'synced') AS status,
      st_contract.last_error AS last_error,
      cr.created_at AS created_at,
      cr.updated_at AS updated_at
    FROM contracts_registry cr
    LEFT JOIN selectors_temp st_contract
      ON st_contract.chain = cr.chain
     AND st_contract.contract_addr = cr.contract_addr
     AND st_contract.selector_hash = COALESCE(cr.contract_selector_hash, CASE WHEN cr.link_type IS NULL THEN cr.selector_hash ELSE NULL END)
    WHERE COALESCE(cr.contract_selector_hash, CASE WHEN cr.link_type IS NULL THEN cr.selector_hash ELSE NULL END) IN (${placeholders})
    UNION ALL
    SELECT
      cr.id AS id,
      cr.chain AS chain,
      cr.contract_addr AS contract_address,
      COALESCE(cr.selector_hash, st.selector_hash) AS pattern_hash,
      CASE
        WHEN cr.link_type = 'proxy' THEN 'implementation'
        WHEN cr.link_type = 'eip7702' THEN 'delegate'
        ELSE 'contract'
      END AS pattern_kind,
      COALESCE(cr.linkage, cr.contract_addr) AS pattern_address,
      cr.label AS label,
      cr.review AS review_text,
      cr.is_exploitable AS exploitable,
      COALESCE(NULLIF(cr.selectors, ''), st.selectors, '') AS selectors,
      COALESCE(st.bytecode_size, cr.code_size, 0) AS bytecode_size,
      COALESCE(st.status, 'synced') AS status,
      st.last_error AS last_error,
      cr.created_at AS created_at,
      cr.updated_at AS updated_at
    FROM contracts_registry cr
    LEFT JOIN selectors_temp st
      ON st.chain = cr.chain
     AND st.contract_addr = cr.contract_addr
     AND st.selector_hash = cr.selector_hash
    WHERE cr.link_type IS NOT NULL
      AND COALESCE(cr.selector_hash, st.selector_hash) IN (${placeholders})
    ORDER BY updated_at DESC, created_at DESC
  `).all(...normalized, ...normalized) as Array<{
    id: string;
    chain: string;
    contract_address: string;
    pattern_hash: string;
    pattern_kind: string;
    pattern_address: string;
    label: string;
    review_text: string;
    exploitable: number;
    selectors: string;
    bytecode_size: number;
    status: string;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const map = new Map<string, SeenContractRow[]>();
  for (const row of rows) {
    const key = row.pattern_hash;
    const list = map.get(key) ?? [];
    list.push(mapSeenContractRow(row));
    map.set(key, list);
  }
  return map;
}

export function getPatternSyncState(remoteName: string): PatternSyncStateRow {
  const row = getDb().prepare(`
    SELECT remote_name, last_pull_at, last_push_at, last_verify_at, updated_at
    FROM pattern_sync_state
    WHERE remote_name = ?
  `).get(remoteName) as {
    remote_name: string;
    last_pull_at: string | null;
    last_push_at: string | null;
    last_verify_at: string | null;
    updated_at: string;
  } | undefined;

  return {
    remoteName,
    lastPullAt: row?.last_pull_at ?? null,
    lastPushAt: row?.last_push_at ?? null,
    lastVerifyAt: row?.last_verify_at ?? null,
    updatedAt: row?.updated_at ?? '',
  };
}

export function updatePatternSyncState(
  remoteName: string,
  fields: Partial<Pick<PatternSyncStateRow, 'lastPullAt' | 'lastPushAt' | 'lastVerifyAt'>>,
): void {
  const current = getPatternSyncState(remoteName);
  getDb().prepare(`
    INSERT INTO pattern_sync_state (remote_name, last_pull_at, last_push_at, last_verify_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(remote_name) DO UPDATE SET
      last_pull_at = excluded.last_pull_at,
      last_push_at = excluded.last_push_at,
      last_verify_at = excluded.last_verify_at,
      updated_at = datetime('now')
  `).run(
    remoteName,
    fields.lastPullAt ?? current.lastPullAt,
    fields.lastPushAt ?? current.lastPushAt,
    fields.lastVerifyAt ?? current.lastVerifyAt,
  );
}

export function upsertSelectorsTempBatch(
  chain: string,
  rows: Array<{
    contractAddr: string;
    selectorHash: string;
    selectors: string[];
    label?: string;
    bytecodeSize?: number;
    status?: string;
    lastError?: string | null;
  }>,
): void {
  const filteredRows = rows.filter((row) =>
    Boolean(row.contractAddr)
    && Boolean(row.selectorHash)
    && Array.isArray(row.selectors)
    && row.selectors.length > 0,
  );
  if (!filteredRows.length) return;
  const chainName = chain.toLowerCase();
  const insert = getDb().prepare(`
    INSERT INTO selectors_temp (
      id, chain, contract_addr, selector_hash, selectors, label,
      bytecode_size, status, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(chain, contract_addr, selector_hash) DO UPDATE SET
      selectors = excluded.selectors,
      label = CASE WHEN excluded.label != '' THEN excluded.label ELSE selectors_temp.label END,
      bytecode_size = CASE
        WHEN excluded.bytecode_size > 0 THEN excluded.bytecode_size
        ELSE selectors_temp.bytecode_size
      END,
      status = CASE
        WHEN excluded.status != '' THEN excluded.status
        ELSE selectors_temp.status
      END,
      last_error = excluded.last_error,
      updated_at = datetime('now')
  `);

  const run = getDb().transaction((entries: typeof filteredRows) => {
    for (const row of entries) {
      const contractAddr = row.contractAddr.toLowerCase();
      const selectorHash = row.selectorHash;
      insert.run(
        v2Id('selector-temp', `${chainName}:${contractAddr}:${selectorHash}`),
        chainName,
        contractAddr,
        selectorHash,
        [...new Set(row.selectors.map((value) => value.toLowerCase()))].join(','),
        row.label ?? '',
        row.bytecodeSize ?? 0,
        row.status ?? 'pending',
        row.lastError ?? null,
      );
    }
  });

  run(filteredRows);
}

export function getAllLegacySeenContractRows(): LegacySeenContractRow[] {
  if (!tableExists('seen_contracts')) return [];
  const rows = getDb().prepare(`
    SELECT
      chain, contract_address, pattern_hash, pattern_kind, pattern_address,
      label, review_text, exploitable, selectors, bytecode_size, updated_at
    FROM seen_contracts
    ORDER BY updated_at DESC, created_at DESC
  `).all() as Array<{
    chain: string;
    contract_address: string;
    pattern_hash: string;
    pattern_kind: string;
    pattern_address: string;
    label: string;
    review_text: string;
    exploitable: number;
    selectors: string;
    bytecode_size: number;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    chain: row.chain.toLowerCase(),
    contractAddress: row.contract_address.toLowerCase(),
    patternHash: row.pattern_hash,
    patternKind: row.pattern_kind,
    patternAddress: row.pattern_address.toLowerCase(),
    label: row.label ?? '',
    reviewText: row.review_text ?? '',
    exploitable: Boolean(row.exploitable),
    selectors: row.selectors.split(',').map((value) => value.trim()).filter(Boolean),
    bytecodeSize: row.bytecode_size ?? 0,
    updatedAt: row.updated_at,
  }));
}

export interface ReadCacheCollections<Run, ContractRows, TokenRows, ContractDetail> {
  persistedRuns: Map<string, Run | null>;
  dashboardContracts: Map<string, { runKey: string; rows: ContractRows }>;
  dashboardTokens: Map<string, { runKey: string; rows: TokenRows }>;
  contractDetails: Map<string, { runKey: string; detail: ContractDetail }>;
}

export interface DashboardReadCache<Run, ContractRows, TokenRows, ContractDetail> {
  invalidate(chain?: string): void;
  invalidateDerived(chain?: string): void;
  resolvePersistedRun(chain: string, build: () => Run | null): Run | null;
  resolveDashboardContracts(chain: string, runKey: string, build: () => ContractRows): ContractRows;
  resolveDashboardTokens(chain: string, runKey: string, build: () => TokenRows): TokenRows;
  resolveContractDetail(cacheKey: string, runKey: string, build: () => ContractDetail): ContractDetail;
}

interface ReadCacheOptions {
  maxPersistedRuns?: number;
  maxCollections?: number;
  maxContractDetails?: number;
}

function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey == null) break;
    map.delete(oldestKey);
  }
}

export function createDashboardReadCache<Run, ContractRows, TokenRows, ContractDetail>(
  options: ReadCacheOptions = {},
): DashboardReadCache<Run, ContractRows, TokenRows, ContractDetail> {
  const persistedRunsOption = options.maxPersistedRuns ?? NaN;
  const collectionsOption = options.maxCollections ?? NaN;
  const contractDetailsOption = options.maxContractDetails ?? NaN;
  const maxPersistedRuns = Number.isFinite(persistedRunsOption) ? Math.max(1, Math.floor(persistedRunsOption)) : 12;
  const maxCollections = Number.isFinite(collectionsOption) ? Math.max(1, Math.floor(collectionsOption)) : 12;
  const maxContractDetails = Number.isFinite(contractDetailsOption) ? Math.max(1, Math.floor(contractDetailsOption)) : 96;

  const collections: ReadCacheCollections<Run, ContractRows, TokenRows, ContractDetail> = {
    persistedRuns: new Map(),
    dashboardContracts: new Map(),
    dashboardTokens: new Map(),
    contractDetails: new Map(),
  };

  function invalidate(chain?: string): void {
    invalidateDerived(chain);
    if (!chain) {
      collections.persistedRuns.clear();
      return;
    }
    collections.persistedRuns.delete(chain.toLowerCase());
  }

  function invalidateDerived(chain?: string): void {
    if (!chain) {
      collections.dashboardContracts.clear();
      collections.dashboardTokens.clear();
      collections.contractDetails.clear();
      return;
    }
    const normalizedChain = chain.toLowerCase();
    collections.dashboardContracts.delete(normalizedChain);
    collections.dashboardTokens.delete(normalizedChain);
    for (const key of [...collections.contractDetails.keys()]) {
      if (key.startsWith(`${normalizedChain}:`)) collections.contractDetails.delete(key);
    }
  }

  function resolvePersistedRun(chain: string, build: () => Run | null): Run | null {
    const normalizedChain = chain.toLowerCase();
    if (collections.persistedRuns.has(normalizedChain)) {
      return collections.persistedRuns.get(normalizedChain) ?? null;
    }
    const value = build();
    setBoundedMapEntry(collections.persistedRuns, normalizedChain, value, maxPersistedRuns);
    return value;
  }

  function resolveDashboardContracts(chain: string, runKey: string, build: () => ContractRows): ContractRows {
    const normalizedChain = chain.toLowerCase();
    const cached = collections.dashboardContracts.get(normalizedChain);
    if (cached?.runKey === runKey) return cached.rows;
    const rows = build();
    setBoundedMapEntry(collections.dashboardContracts, normalizedChain, { runKey, rows }, maxCollections);
    return rows;
  }

  function resolveDashboardTokens(chain: string, runKey: string, build: () => TokenRows): TokenRows {
    const normalizedChain = chain.toLowerCase();
    const cached = collections.dashboardTokens.get(normalizedChain);
    if (cached?.runKey === runKey) return cached.rows;
    const rows = build();
    setBoundedMapEntry(collections.dashboardTokens, normalizedChain, { runKey, rows }, maxCollections);
    return rows;
  }

  function resolveContractDetail(cacheKey: string, runKey: string, build: () => ContractDetail): ContractDetail {
    const cached = collections.contractDetails.get(cacheKey);
    if (cached?.runKey === runKey) return cached.detail;
    const detail = build();
    setBoundedMapEntry(collections.contractDetails, cacheKey, { runKey, detail }, maxContractDetails);
    return detail;
  }

  return {
    invalidate,
    invalidateDerived,
    resolvePersistedRun,
    resolveDashboardContracts,
    resolveDashboardTokens,
    resolveContractDetail,
  };
}

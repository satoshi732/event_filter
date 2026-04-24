import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getAppSetting,
  listAiAuditModels,
  listAiAuditProviders,
  listChainSettings,
  replaceAiAuditModels,
  replaceAiAuditProviders,
  setManyAppSettings,
  upsertChainSettings,
  type AiAuditModelRow,
  type AiAuditProviderRow,
  type ChainSettingRow,
} from './db/settings.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEGACY_CONFIG_FILE = path.join(ROOT, 'config.json');
const LEGACY_KEYS_FILE = path.join(ROOT, 'keys.json');
const DEFAULT_MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';
const STATIC_PANCAKESWAP_PRICE_LIMITER = {
  max_req_per_second: 2,
  max_req_per_minute: 90,
} as const;

export interface AppConfig {
  chainbase_keys?: string[];
  rpc_keys?: string[];
  monitor_chains?: string[];
  poll_interval_ms?: number;
  debug?: boolean;
  pattern_sync?: {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    remote_name?: string;
    auto_pull?: boolean;
    ssl?: boolean;
  };
  pancakeswap_price?: {
    max_req_per_second?: number;
    max_req_per_minute?: number;
  };
  ai_audit?: {
    providers?: Array<{
      provider: string;
      enabled: boolean;
      position: number;
    }>;
    models?: Array<{
      provider: string;
      model: string;
      enabled: boolean;
      is_default: boolean;
      position: number;
    }>;
  };
  ai_audit_backend?: {
    base_url?: string;
    api_key?: string;
    etherscan_api_key?: string;
    poll_interval_ms?: number;
    dedaub_wait_seconds?: number;
    insecure_tls?: boolean;
  };
  auto_analysis?: {
    queue_capacity?: number;
    round_audit_limit?: number;
    round_rest_seconds?: number;
    stop_at_time?: string;
    token_share_percent?: number;
    contract_share_percent?: number;
    provider?: string;
    model?: string;
    contract_min_tvl_usd?: number;
    token_min_price_usd?: number;
    require_token_sync?: boolean;
    require_contract_selectors?: boolean;
    skip_seen_contracts?: boolean;
    one_per_contract_pattern?: boolean;
    retry_failed_audits?: boolean;
    exclude_audited_contracts?: boolean;
    exclude_audited_tokens?: boolean;
  };
  web_security?: {
    https_enabled?: boolean;
    tls_cert_path?: string;
    tls_key_path?: string;
  };
}

export interface PatternSyncConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  remoteName: string;
  autoPull: boolean;
  ssl: boolean;
}

export interface ChainConfig {
  name: string;
  chainId: number;
  tablePrefix: string;
  blocksPerScan: number;
  chainbaseKeys: string[];
  rpcNetwork: string;
  rpcUrls: string[];
  multicall3Address: string;
  wrappedNativeTokenAddress: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

interface RuntimeConfigCache {
  appConfig: AppConfig;
  chainConfigs: Record<string, ChainConfig>;
  aiProviders: AiAuditProviderRow[];
  aiModels: AiAuditModelRow[];
}

interface LegacyFileConfig {
  chainbase_keys?: string[];
  rpc?: Record<string, string[]>;
  multicall3?: Record<string, string>;
  infura_keys?: string[];
  pattern_sync?: {
    host?: string;
    port?: number;
    database?: string;
    dbname?: string;
    user?: string;
    password?: string;
    remote_name?: string;
    auto_pull?: boolean;
    ssl?: boolean;
  };
  monitor_chains?: string[];
  poll_interval_ms?: number;
  debug?: boolean;
  pancakeswap_price?: {
    max_req_per_second?: number;
    max_req_per_minute?: number;
  };
}

interface LegacyKeysFile {
  chainbase_keys?: string[];
  infura_keys?: string[];
  multicall3?: Record<string, string>;
  pattern_sync?: {
    host?: string;
    port?: number;
    database?: string;
    dbname?: string;
    user?: string;
    password?: string;
    remote_name?: string;
    auto_pull?: boolean;
    ssl?: boolean;
  };
}

const BASE_CHAIN_CONFIGS: Record<string, Omit<ChainConfig, 'blocksPerScan' | 'chainbaseKeys' | 'rpcNetwork' | 'rpcUrls' | 'multicall3Address'>> = {
  ethereum:  { name: 'Ethereum',  chainId: 1,     tablePrefix: 'ethereum',  wrappedNativeTokenAddress: '0xc02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  bsc:       { name: 'BSC',       chainId: 56,    tablePrefix: 'bsc',       wrappedNativeTokenAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 } },
  polygon:   { name: 'Polygon',   chainId: 137,   tablePrefix: 'polygon',   wrappedNativeTokenAddress: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 } },
  arbitrum:  { name: 'Arbitrum',  chainId: 42161, tablePrefix: 'arbitrum',  wrappedNativeTokenAddress: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  optimism:  { name: 'Optimism',  chainId: 10,    tablePrefix: 'op',        wrappedNativeTokenAddress: '0x4200000000000000000000000000000000000006', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  base:      { name: 'Base',      chainId: 8453,  tablePrefix: 'base',      wrappedNativeTokenAddress: '0x4200000000000000000000000000000000000006', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  avalanche: { name: 'Avalanche', chainId: 43114, tablePrefix: 'avalanche', wrappedNativeTokenAddress: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 } },
};

const DEFAULT_BLOCKS_PER_SCAN: Record<string, number> = {
  ethereum: 12,
  bsc: 20,
  polygon: 75,
  arbitrum: 600,
  optimism: 75,
  base: 75,
  avalanche: 75,
};

const INFURA_NETWORK_BY_CHAIN: Record<string, string> = {
  ethereum: 'mainnet',
  bsc: 'bsc-mainnet',
  polygon: 'polygon-mainnet',
  arbitrum: 'arbitrum-mainnet',
  optimism: 'optimism-mainnet',
  base: 'base-mainnet',
  avalanche: 'avalanche-mainnet',
};

let runtimeConfigCache: RuntimeConfigCache | null = null;
let seeded = false;

const AI_AUDIT_PROVIDER_CODEX = 'codex';
const AI_AUDIT_DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_AI_AUDIT_SEED: Record<string, string[]> = {
  [AI_AUDIT_PROVIDER_CODEX]: [AI_AUDIT_DEFAULT_MODEL],
};

function defaultCodexProviderRow(): AiAuditProviderRow {
  return {
    provider: AI_AUDIT_PROVIDER_CODEX,
    enabled: true,
    position: 0,
    updatedAt: '',
  };
}

function defaultCodexModelRow(): AiAuditModelRow {
  return {
    id: 0,
    provider: AI_AUDIT_PROVIDER_CODEX,
    model: AI_AUDIT_DEFAULT_MODEL,
    enabled: true,
    isDefault: true,
    position: 0,
    updatedAt: '',
  };
}

function sanitizeAiProviderRows(rows: AiAuditProviderRow[]): AiAuditProviderRow[] {
  const filtered = rows
    .filter((row) => String(row.provider || '').trim().toLowerCase() === AI_AUDIT_PROVIDER_CODEX)
    .map((row) => ({
      ...row,
      provider: AI_AUDIT_PROVIDER_CODEX,
    }));
  return filtered.length ? filtered : [defaultCodexProviderRow()];
}

function sanitizeAiModelRows(rows: AiAuditModelRow[]): AiAuditModelRow[] {
  const filtered = rows
    .filter((row) => (
      String(row.provider || '').trim().toLowerCase() === AI_AUDIT_PROVIDER_CODEX
      && String(row.model || '').trim() === AI_AUDIT_DEFAULT_MODEL
    ))
    .map((row) => ({
      ...row,
      provider: AI_AUDIT_PROVIDER_CODEX,
      model: AI_AUDIT_DEFAULT_MODEL,
    }));
  return filtered.length ? filtered : [defaultCodexModelRow()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function titleCaseSlug(value: string): string {
  return String(value || '')
    .split(/[-_\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parsePositiveFloat(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBool(value: string | null | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeTimeOfDay(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const match = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return '';
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseStringList(value: string | null | undefined, fallback: string[] = []): string[] {
  if (!value) return [...fallback];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [...fallback];
    return uniqueStrings(parsed.map((entry) => String(entry || '')));
  } catch {
    return [...fallback];
  }
}

function stringifyStringList(values: string[]): string {
  return JSON.stringify(uniqueStrings(values));
}

function isRelativeProjectCertPath(rawPath: string): boolean {
  const normalized = rawPath.trim().replaceAll('\\', '/').replace(/^\.\/+/, '');
  return normalized === 'certs' || normalized.startsWith('certs/');
}

function discoverTlsPairFromCertsDir(): { certPath: string; keyPath: string } | null {
  const certsDir = path.join(ROOT, 'certs');
  if (!existsSync(certsDir)) return null;

  const entries = readdirSync(certsDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  const certBases = new Set(
    entries
      .map((entry) => entry.name)
      .filter((name) => name.endsWith('.crt'))
      .map((name) => name.slice(0, -4)),
  );
  const keyBases = new Set(
    entries
      .map((entry) => entry.name)
      .filter((name) => name.endsWith('.key'))
      .map((name) => name.slice(0, -4)),
  );

  const ranked = [...certBases]
    .filter((base) => keyBases.has(base))
    .map((base) => {
      const certAbsPath = path.join(certsDir, `${base}.crt`);
      const keyAbsPath = path.join(certsDir, `${base}.key`);
      const mtimeMs = Math.max(statSync(certAbsPath).mtimeMs, statSync(keyAbsPath).mtimeMs);
      const normalizedBase = base.trim().toLowerCase();
      const looksLikeIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalizedBase);
      const priority =
        normalizedBase === 'server'
          ? 3
          : normalizedBase === 'localhost'
            ? 2
            : looksLikeIpv4
              ? 1
              : 0;
      return { base, mtimeMs, priority };
    })
    .sort((left, right) => (
      right.priority - left.priority
      || right.mtimeMs - left.mtimeMs
      || left.base.localeCompare(right.base)
    ));

  const selected = ranked[0];
  if (!selected) return null;
  return {
    certPath: `certs/${selected.base}.crt`,
    keyPath: `certs/${selected.base}.key`,
  };
}

function resolveTlsPaths(rawCertPath: string | null | undefined, rawKeyPath: string | null | undefined): {
  tlsCertPath: string;
  tlsKeyPath: string;
  autoDiscovered: boolean;
} {
  const tlsCertPath = String(rawCertPath || '').trim();
  const tlsKeyPath = String(rawKeyPath || '').trim();
  const canAutoDiscover = !tlsCertPath
    || !tlsKeyPath
    || (isRelativeProjectCertPath(tlsCertPath) && isRelativeProjectCertPath(tlsKeyPath));

  if (canAutoDiscover) {
    const discovered = discoverTlsPairFromCertsDir();
    if (discovered) {
      return {
        tlsCertPath: discovered.certPath,
        tlsKeyPath: discovered.keyPath,
        autoDiscovered: true,
      };
    }
  }

  return {
    tlsCertPath,
    tlsKeyPath,
    autoDiscovered: false,
  };
}

function buildInfuraRpcUrls(network: string, infuraKeys: string[]): string[] {
  const normalizedNetwork = String(network || '').trim();
  if (!normalizedNetwork || !infuraKeys.length) return [];
  return infuraKeys.map((key) => `https://${normalizedNetwork}.infura.io/v3/${key}`);
}

function resolveRpcNetwork(chain: string, configured: string | null | undefined): string {
  const normalizedConfigured = String(configured || '').trim();
  if (normalizedConfigured) return normalizedConfigured;
  return INFURA_NETWORK_BY_CHAIN[chain.toLowerCase()] || '';
}

function fallbackChainName(chain: string): string {
  return titleCaseSlug(chain) || chain || 'Unknown';
}

function fallbackNativeSymbol(chain: string): string {
  return String(chain || '').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || 'NATIVE';
}

function readLegacyFileConfig(): LegacyFileConfig {
  if (!existsSync(LEGACY_CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(LEGACY_CONFIG_FILE, 'utf-8')) as LegacyFileConfig;
  } catch (e) {
    console.warn(`[config] Failed to parse legacy config.json: ${(e as Error).message}`);
    return {};
  }
}

function readLegacyKeysFile(): LegacyKeysFile {
  if (!existsSync(LEGACY_KEYS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(LEGACY_KEYS_FILE, 'utf-8')) as LegacyKeysFile;
  } catch (e) {
    console.warn(`[config] Failed to parse legacy keys.json: ${(e as Error).message}`);
    return {};
  }
}

function defaultAiProviders(): Array<{ provider: string; enabled: boolean; position: number }> {
  return [{
    provider: AI_AUDIT_PROVIDER_CODEX,
    enabled: true,
    position: 0,
  }];
}

function defaultAiModels(): Array<{ provider: string; model: string; enabled: boolean; is_default: boolean; position: number }> {
  return Object.entries(DEFAULT_AI_AUDIT_SEED).flatMap(([provider, models]) =>
    models.map((model, index) => ({
      provider,
      model,
      enabled: true,
      is_default: index === 0,
      position: index,
    })));
}

function getAiAuditProviderOptionsFromRows(rows: AiAuditProviderRow[]): string[] {
  const enabled = rows
    .filter((row) => row.enabled)
    .sort((a, b) => a.position - b.position || a.provider.localeCompare(b.provider))
    .map((row) => row.provider);
  return enabled.length ? enabled : Object.keys(DEFAULT_AI_AUDIT_SEED);
}

function normalizeAiAuditProviderFromRows(
  provider: string | null | undefined,
  rows: AiAuditProviderRow[],
): string {
  const normalized = String(provider || '').trim().toLowerCase();
  const allowed = getAiAuditProviderOptionsFromRows(rows);
  return allowed.includes(normalized)
    ? normalized
    : (allowed[0] || AI_AUDIT_PROVIDER_CODEX);
}

function getAiAuditModelOptionsFromRows(
  provider: string | null | undefined,
  providers: AiAuditProviderRow[],
  models: AiAuditModelRow[],
): string[] {
  const normalizedProvider = normalizeAiAuditProviderFromRows(provider, providers);
  const enabled = models
    .filter((row) => row.provider === normalizedProvider && row.enabled)
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.position - b.position || a.model.localeCompare(b.model);
    })
    .map((row) => row.model);
  return enabled.length ? enabled : [...(DEFAULT_AI_AUDIT_SEED[normalizedProvider] ?? [])];
}

function normalizeAiAuditModelFromRows(
  provider: string | null | undefined,
  model: string | null | undefined,
  providers: AiAuditProviderRow[],
  models: AiAuditModelRow[],
): string {
  const normalizedProvider = normalizeAiAuditProviderFromRows(provider, providers);
  const normalizedModel = String(model || '').trim();
  const allowed = getAiAuditModelOptionsFromRows(normalizedProvider, providers, models);
  return allowed.includes(normalizedModel)
    ? normalizedModel
    : (allowed[0] || '');
}

function seedRuntimeConfigIfNeeded(): void {
  if (seeded) return;
  seeded = true;

  const legacy = readLegacyFileConfig();
  const legacyKeys = readLegacyKeysFile();
  const existingChains = listChainSettings();
  if (!existingChains.length) {
    const rows = Object.keys(BASE_CHAIN_CONFIGS).map((chain) => {
      const base = BASE_CHAIN_CONFIGS[chain];
      const multicall3Address = String(
        legacy.multicall3?.[chain]
        ?? legacy.multicall3?.[chain.toLowerCase()]
        ?? legacyKeys.multicall3?.[chain]
        ?? legacyKeys.multicall3?.[chain.toLowerCase()]
        ?? DEFAULT_MULTICALL3_ADDRESS,
      ).trim().toLowerCase();
      return {
        chain,
        name: base.name,
        chainId: base.chainId,
        tablePrefix: base.tablePrefix,
        blocksPerScan: DEFAULT_BLOCKS_PER_SCAN[chain] ?? 75,
        chainbaseKeys: [],
        rpcNetwork: INFURA_NETWORK_BY_CHAIN[chain] ?? '',
        rpcUrls: [],
        multicall3Address: multicall3Address || DEFAULT_MULTICALL3_ADDRESS,
        wrappedNativeTokenAddress: base.wrappedNativeTokenAddress,
        nativeCurrencyName: base.nativeCurrency.name,
        nativeCurrencySymbol: base.nativeCurrency.symbol,
        nativeCurrencyDecimals: base.nativeCurrency.decimals,
      };
    });
    upsertChainSettings(rows);
  }
  const appEntries: Array<{ key: string; value: string }> = [];
  if (getAppSetting('monitor_chains') == null) {
    appEntries.push({
      key: 'monitor_chains',
      value: stringifyStringList(
        Array.isArray(legacy.monitor_chains) && legacy.monitor_chains.length
          ? legacy.monitor_chains
          : ['ethereum'],
      ),
    });
  }
  if (getAppSetting('chainbase_keys') == null) {
    appEntries.push({
      key: 'chainbase_keys',
      value: stringifyStringList(legacy.chainbase_keys?.length ? legacy.chainbase_keys : (legacyKeys.chainbase_keys ?? [])),
    });
  }
  if (getAppSetting('rpc_keys') == null) {
    appEntries.push({
      key: 'rpc_keys',
      value: stringifyStringList(legacy.infura_keys?.length ? legacy.infura_keys : (legacyKeys.infura_keys ?? [])),
    });
  }
  if (getAppSetting('poll_interval_ms') == null) {
    appEntries.push({ key: 'poll_interval_ms', value: String(parsePositiveInt(legacy.poll_interval_ms, 600_000)) });
  }
  if (getAppSetting('debug') == null) {
    appEntries.push({ key: 'debug', value: legacy.debug ? '1' : '0' });
  }
  if (getAppSetting('pattern_sync.host') == null) {
    const patternSync = legacy.pattern_sync ?? legacyKeys.pattern_sync ?? {};
    appEntries.push({ key: 'pattern_sync.host', value: String(patternSync.host?.trim() || '') });
    appEntries.push({ key: 'pattern_sync.port', value: String(parsePositiveInt(patternSync.port, 5432)) });
    appEntries.push({
      key: 'pattern_sync.database',
      value: String(patternSync.database?.trim() || patternSync.dbname?.trim() || ''),
    });
    appEntries.push({ key: 'pattern_sync.user', value: String(patternSync.user?.trim() || '') });
    appEntries.push({ key: 'pattern_sync.password', value: String(patternSync.password?.trim() || '') });
    appEntries.push({ key: 'pattern_sync.remote_name', value: String(patternSync.remote_name?.trim() || 'default') });
    appEntries.push({ key: 'pattern_sync.auto_pull', value: patternSync.auto_pull === false ? '0' : '1' });
    appEntries.push({ key: 'pattern_sync.ssl', value: patternSync.ssl ? '1' : '0' });
  }
  if (getAppSetting('pancakeswap_price.max_req_per_second') == null) {
    appEntries.push({
      key: 'pancakeswap_price.max_req_per_second',
      value: String(parsePositiveInt(legacy.pancakeswap_price?.max_req_per_second, 2)),
    });
    appEntries.push({
      key: 'pancakeswap_price.max_req_per_minute',
      value: String(parsePositiveInt(legacy.pancakeswap_price?.max_req_per_minute, 90)),
    });
  }
  if (getAppSetting('ai_audit_backend.base_url') == null) {
    appEntries.push({ key: 'ai_audit_backend.base_url', value: 'https://127.0.0.1:5000' });
    appEntries.push({ key: 'ai_audit_backend.api_key', value: '' });
    appEntries.push({ key: 'ai_audit_backend.etherscan_api_key', value: '' });
    appEntries.push({ key: 'ai_audit_backend.poll_interval_ms', value: '10000' });
    appEntries.push({ key: 'ai_audit_backend.dedaub_wait_seconds', value: '15' });
    appEntries.push({ key: 'ai_audit_backend.insecure_tls', value: '1' });
  }
  if (getAppSetting('auto_analysis.queue_capacity') == null) {
    appEntries.push({ key: 'auto_analysis.queue_capacity', value: '10' });
    appEntries.push({ key: 'auto_analysis.token_share_percent', value: '40' });
    appEntries.push({ key: 'auto_analysis.contract_share_percent', value: '60' });
    appEntries.push({ key: 'auto_analysis.contract_min_tvl_usd', value: '10000' });
    appEntries.push({ key: 'auto_analysis.token_min_price_usd', value: '0.001' });
    appEntries.push({ key: 'auto_analysis.require_token_sync', value: '1' });
    appEntries.push({ key: 'auto_analysis.require_contract_selectors', value: '1' });
    appEntries.push({ key: 'auto_analysis.skip_seen_contracts', value: '1' });
    appEntries.push({ key: 'auto_analysis.one_per_contract_pattern', value: '1' });
    appEntries.push({ key: 'auto_analysis.exclude_audited_contracts', value: '1' });
    appEntries.push({ key: 'auto_analysis.exclude_audited_tokens', value: '1' });
  }
  if (getAppSetting('auto_analysis.round_audit_limit') == null) {
    appEntries.push({ key: 'auto_analysis.round_audit_limit', value: '5' });
  }
  if (getAppSetting('auto_analysis.round_rest_seconds') == null) {
    appEntries.push({ key: 'auto_analysis.round_rest_seconds', value: '60' });
  }
  if (getAppSetting('auto_analysis.retry_failed_audits') == null) {
    appEntries.push({ key: 'auto_analysis.retry_failed_audits', value: '1' });
  }
  if (getAppSetting('web_security.auth_enabled') == null) {
    const discoveredTls = discoverTlsPairFromCertsDir();
    appEntries.push({ key: 'web_security.https_enabled', value: discoveredTls ? '1' : '0' });
    appEntries.push({ key: 'web_security.tls_cert_path', value: discoveredTls?.certPath ?? '' });
    appEntries.push({ key: 'web_security.tls_key_path', value: discoveredTls?.keyPath ?? '' });
  }
  if (!listAiAuditProviders().length) {
    replaceAiAuditProviders(defaultAiProviders());
  }
  if (!listAiAuditModels().length) {
    replaceAiAuditModels(defaultAiModels().map((row) => ({
      provider: row.provider,
      model: row.model,
      enabled: row.enabled,
      isDefault: row.is_default,
      position: row.position,
    })));
  }

  const seededProviders = listAiAuditProviders();
  const seededModels = listAiAuditModels();
  if (getAppSetting('auto_analysis.provider') == null) {
    appEntries.push({
      key: 'auto_analysis.provider',
      value: normalizeAiAuditProviderFromRows(null, seededProviders),
    });
  }
  if (getAppSetting('auto_analysis.model') == null) {
    const provider = normalizeAiAuditProviderFromRows(getAppSetting('auto_analysis.provider'), seededProviders);
    appEntries.push({
      key: 'auto_analysis.model',
      value: normalizeAiAuditModelFromRows(provider, null, seededProviders, seededModels),
    });
  }
  if (appEntries.length) {
    setManyAppSettings(appEntries);
  }
}

function buildChainConfigs(rows: ChainSettingRow[]): Record<string, ChainConfig> {
  const map: Record<string, ChainConfig> = {};
  const sharedChainbaseKeys = parseStringList(getAppSetting('chainbase_keys'));
  const sharedRpcKeys = parseStringList(getAppSetting('rpc_keys'));
  const allChains = [...new Set([
    ...Object.keys(BASE_CHAIN_CONFIGS),
    ...rows.map((entry) => String(entry.chain || '').trim().toLowerCase()).filter(Boolean),
  ])];

  for (const chain of allChains) {
    const base = BASE_CHAIN_CONFIGS[chain];
    const row = rows.find((entry) => entry.chain === chain);
    const configuredChainbaseKeys = uniqueStrings((row?.chainbaseKeys ?? []).map((entry) => String(entry || '').trim()));
    const rpcNetwork = resolveRpcNetwork(chain, row?.rpcNetwork);
    map[chain] = {
      name: String(row?.name || base?.name || fallbackChainName(chain)).trim(),
      chainId: parsePositiveInt(row?.chainId, base?.chainId ?? 0),
      tablePrefix: String(row?.tablePrefix || base?.tablePrefix || chain).trim(),
      blocksPerScan: parsePositiveInt(row?.blocksPerScan, DEFAULT_BLOCKS_PER_SCAN[chain] ?? 75),
      chainbaseKeys: configuredChainbaseKeys.length ? configuredChainbaseKeys : sharedChainbaseKeys,
      rpcNetwork,
      rpcUrls: buildInfuraRpcUrls(rpcNetwork, sharedRpcKeys),
      multicall3Address: (row?.multicall3Address || DEFAULT_MULTICALL3_ADDRESS).trim().toLowerCase(),
      wrappedNativeTokenAddress: String(row?.wrappedNativeTokenAddress || base?.wrappedNativeTokenAddress || '').trim().toLowerCase(),
      nativeCurrency: {
        name: String(row?.nativeCurrencyName || base?.nativeCurrency.name || fallbackChainName(chain)).trim(),
        symbol: String(row?.nativeCurrencySymbol || base?.nativeCurrency.symbol || fallbackNativeSymbol(chain)).trim(),
        decimals: parsePositiveInt(row?.nativeCurrencyDecimals, base?.nativeCurrency.decimals ?? 18),
      },
    };
  }
  return map;
}

function loadRuntimeConfigFromDb(): RuntimeConfigCache {
  seedRuntimeConfigIfNeeded();

  const chainRows = listChainSettings();
  const aiProviders = sanitizeAiProviderRows(listAiAuditProviders());
  const aiModels = sanitizeAiModelRows(listAiAuditModels());
  const autoAnalysisProvider = normalizeAiAuditProviderFromRows(getAppSetting('auto_analysis.provider'), aiProviders);
  const autoAnalysisModel = normalizeAiAuditModelFromRows(
    autoAnalysisProvider,
    getAppSetting('auto_analysis.model'),
    aiProviders,
    aiModels,
  );
  const chainConfigs = buildChainConfigs(chainRows);
  const monitorChains = parseStringList(getAppSetting('monitor_chains'), ['ethereum'])
    .map((value) => value.toLowerCase())
    .filter((value) => value in chainConfigs);

  const appConfig: AppConfig = {
    chainbase_keys: parseStringList(getAppSetting('chainbase_keys')),
    rpc_keys: parseStringList(getAppSetting('rpc_keys')),
    monitor_chains: monitorChains.length ? monitorChains : ['ethereum'],
    poll_interval_ms: parsePositiveInt(getAppSetting('poll_interval_ms'), 600_000),
    debug: parseBool(getAppSetting('debug'), false),
    pattern_sync: {
      host: String(getAppSetting('pattern_sync.host') || ''),
      port: parsePositiveInt(getAppSetting('pattern_sync.port'), 5432),
      database: String(getAppSetting('pattern_sync.database') || ''),
      user: String(getAppSetting('pattern_sync.user') || ''),
      password: String(getAppSetting('pattern_sync.password') || ''),
      remote_name: String(getAppSetting('pattern_sync.remote_name') || 'default'),
      auto_pull: parseBool(getAppSetting('pattern_sync.auto_pull'), true),
      ssl: parseBool(getAppSetting('pattern_sync.ssl'), false),
    },
    pancakeswap_price: { ...STATIC_PANCAKESWAP_PRICE_LIMITER },
    ai_audit: {
      providers: aiProviders.map((row) => ({
        provider: row.provider,
        enabled: row.enabled,
        position: row.position,
      })),
      models: aiModels.map((row) => ({
        provider: row.provider,
        model: row.model,
        enabled: row.enabled,
        is_default: row.isDefault,
        position: row.position,
      })),
    },
    ai_audit_backend: {
      base_url: String(getAppSetting('ai_audit_backend.base_url') || 'https://127.0.0.1:5000'),
      api_key: String(getAppSetting('ai_audit_backend.api_key') || ''),
      etherscan_api_key: String(getAppSetting('ai_audit_backend.etherscan_api_key') || ''),
      poll_interval_ms: parsePositiveInt(getAppSetting('ai_audit_backend.poll_interval_ms'), 10_000),
      dedaub_wait_seconds: parsePositiveInt(getAppSetting('ai_audit_backend.dedaub_wait_seconds'), 15),
      insecure_tls: parseBool(getAppSetting('ai_audit_backend.insecure_tls'), true),
    },
    auto_analysis: {
      queue_capacity: parsePositiveInt(getAppSetting('auto_analysis.queue_capacity'), 10),
      round_audit_limit: parsePositiveInt(getAppSetting('auto_analysis.round_audit_limit'), 5),
      round_rest_seconds: parsePositiveInt(getAppSetting('auto_analysis.round_rest_seconds'), 60),
      stop_at_time: normalizeTimeOfDay(getAppSetting('auto_analysis.stop_at_time')),
      token_share_percent: parsePositiveInt(getAppSetting('auto_analysis.token_share_percent'), 40),
      contract_share_percent: parsePositiveInt(getAppSetting('auto_analysis.contract_share_percent'), 60),
      provider: autoAnalysisProvider,
      model: autoAnalysisModel,
      contract_min_tvl_usd: parsePositiveFloat(getAppSetting('auto_analysis.contract_min_tvl_usd'), 10_000),
      token_min_price_usd: parsePositiveFloat(getAppSetting('auto_analysis.token_min_price_usd'), 0.001),
      require_token_sync: parseBool(getAppSetting('auto_analysis.require_token_sync'), true),
      require_contract_selectors: parseBool(getAppSetting('auto_analysis.require_contract_selectors'), true),
      skip_seen_contracts: parseBool(getAppSetting('auto_analysis.skip_seen_contracts'), true),
      one_per_contract_pattern: parseBool(getAppSetting('auto_analysis.one_per_contract_pattern'), true),
      retry_failed_audits: parseBool(getAppSetting('auto_analysis.retry_failed_audits'), true),
      exclude_audited_contracts: parseBool(getAppSetting('auto_analysis.exclude_audited_contracts'), true),
      exclude_audited_tokens: parseBool(getAppSetting('auto_analysis.exclude_audited_tokens'), true),
    },
    web_security: {
      https_enabled: parseBool(getAppSetting('web_security.https_enabled'), false),
      tls_cert_path: String(getAppSetting('web_security.tls_cert_path') || '').trim(),
      tls_key_path: String(getAppSetting('web_security.tls_key_path') || '').trim(),
    },
  };

  return {
    appConfig,
    chainConfigs,
    aiProviders,
    aiModels,
  };
}

function ensureRuntimeCache(): RuntimeConfigCache {
  if (!runtimeConfigCache) {
    runtimeConfigCache = loadRuntimeConfigFromDb();
  }
  return runtimeConfigCache;
}

export function reloadRuntimeConfig(): AppConfig {
  runtimeConfigCache = loadRuntimeConfigFromDb();
  return getConfigSnapshot();
}

export function getConfigSnapshot(): AppConfig {
  const cache = ensureRuntimeCache();
  return JSON.parse(JSON.stringify(cache.appConfig)) as AppConfig;
}

export function getAvailableChains(): string[] {
  return Object.keys(ensureRuntimeCache().chainConfigs);
}

export function getChainConfigsSnapshot(): Record<string, ChainConfig> {
  const cache = ensureRuntimeCache();
  return JSON.parse(JSON.stringify(cache.chainConfigs)) as Record<string, ChainConfig>;
}

export function getChainConfig(chain: string): ChainConfig {
  const cache = ensureRuntimeCache();
  const cfg = cache.chainConfigs[chain.toLowerCase()];
  if (!cfg) throw new Error(`Unknown chain: "${chain}". Supported: ${Object.keys(cache.chainConfigs).join(', ')}`);
  return cfg;
}

export function getMonitoredChains(): string[] {
  return [...(ensureRuntimeCache().appConfig.monitor_chains ?? ['ethereum'])];
}

export function getPollIntervalMs(): number {
  return ensureRuntimeCache().appConfig.poll_interval_ms ?? 600_000;
}

export function getDebugEnabled(): boolean {
  return Boolean(ensureRuntimeCache().appConfig.debug);
}

export function getPatternSyncConfig(): PatternSyncConfig | undefined {
  const raw = ensureRuntimeCache().appConfig.pattern_sync ?? {};
  const host = raw.host?.trim();
  const user = raw.user?.trim();
  const password = raw.password?.trim();
  const database = raw.database?.trim();
  if (!host || !user || !password || !database) return undefined;
  return {
    host,
    port: parsePositiveInt(raw.port, 5432),
    database,
    user,
    password,
    remoteName: raw.remote_name?.trim() || 'default',
    autoPull: raw.auto_pull ?? true,
    ssl: raw.ssl ?? false,
  };
}

export function getPancakeSwapPriceLimiterConfig(): { maxReqPerSecond: number; maxReqPerMinute: number } {
  return {
    maxReqPerSecond: STATIC_PANCAKESWAP_PRICE_LIMITER.max_req_per_second,
    maxReqPerMinute: STATIC_PANCAKESWAP_PRICE_LIMITER.max_req_per_minute,
  };
}

export function getAiAuditProviderConfigs(): AiAuditProviderRow[] {
  return JSON.parse(JSON.stringify(sanitizeAiProviderRows(ensureRuntimeCache().aiProviders))) as AiAuditProviderRow[];
}

export function getAiAuditModelConfigs(): AiAuditModelRow[] {
  return JSON.parse(JSON.stringify(sanitizeAiModelRows(ensureRuntimeCache().aiModels))) as AiAuditModelRow[];
}

export function getAiAuditProviderOptions(): string[] {
  const enabled = sanitizeAiProviderRows(ensureRuntimeCache().aiProviders)
    .filter((row) => row.enabled)
    .sort((a, b) => a.position - b.position || a.provider.localeCompare(b.provider))
    .map((row) => row.provider);
  return enabled.length ? enabled : Object.keys(DEFAULT_AI_AUDIT_SEED);
}

export function getDefaultAiAuditProvider(): string {
  return getAiAuditProviderOptions()[0] || AI_AUDIT_PROVIDER_CODEX;
}

export function normalizeAiAuditProvider(provider: string | null | undefined): string {
  const normalized = String(provider || '').trim().toLowerCase();
  return getAiAuditProviderOptions().includes(normalized)
    ? normalized
    : getDefaultAiAuditProvider();
}

export function getAiAuditModelOptions(provider: string | null | undefined): string[] {
  const normalizedProvider = normalizeAiAuditProvider(provider);
  const enabled = sanitizeAiModelRows(ensureRuntimeCache().aiModels)
    .filter((row) => row.provider === normalizedProvider && row.enabled)
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.position - b.position || a.model.localeCompare(b.model);
    })
    .map((row) => row.model);
  return enabled.length ? enabled : [...(DEFAULT_AI_AUDIT_SEED[normalizedProvider] ?? [])];
}

export function getDefaultAiAuditModel(provider: string | null | undefined): string {
  return getAiAuditModelOptions(provider)[0] || '';
}

export function normalizeAiAuditModel(provider: string | null | undefined, model: string | null | undefined): string {
  const normalizedProvider = normalizeAiAuditProvider(provider);
  const normalizedModel = String(model || '').trim();
  const allowed = getAiAuditModelOptions(normalizedProvider);
  return allowed.includes(normalizedModel)
    ? normalizedModel
    : getDefaultAiAuditModel(normalizedProvider);
}

export function getAiAuditBackendConfig(): {
  baseUrl: string;
  apiKey: string;
  etherscanApiKey: string;
  pollIntervalMs: number;
  dedaubWaitSeconds: number;
  insecureTls: boolean;
} {
  const raw = ensureRuntimeCache().appConfig.ai_audit_backend ?? {};
  return {
    baseUrl: String(raw.base_url || 'https://127.0.0.1:5000').trim().replace(/\/+$/, ''),
    apiKey: String(raw.api_key || '').trim(),
    etherscanApiKey: String(raw.etherscan_api_key || '').trim(),
    pollIntervalMs: parsePositiveInt(raw.poll_interval_ms, 10_000),
    dedaubWaitSeconds: parsePositiveInt(raw.dedaub_wait_seconds, 15),
    insecureTls: Boolean(raw.insecure_tls ?? true),
  };
}

export function getAutoAnalysisConfig(): {
  queueCapacity: number;
  roundAuditLimit: number;
  roundRestSeconds: number;
  stopAtTime: string | null;
  tokenSharePercent: number;
  contractSharePercent: number;
  provider: string;
  model: string;
  contractMinTvlUsd: number;
  tokenMinPriceUsd: number;
  requireTokenSync: boolean;
  requireContractSelectors: boolean;
  skipSeenContracts: boolean;
  onePerContractPattern: boolean;
  retryFailedAudits: boolean;
  excludeAuditedContracts: boolean;
  excludeAuditedTokens: boolean;
} {
  const raw = ensureRuntimeCache().appConfig.auto_analysis ?? {};
  const provider = normalizeAiAuditProvider(raw.provider);
  return {
    queueCapacity: parsePositiveInt(raw.queue_capacity, 10),
    roundAuditLimit: parsePositiveInt(raw.round_audit_limit, 5),
    roundRestSeconds: parsePositiveInt(raw.round_rest_seconds, 60),
    stopAtTime: normalizeTimeOfDay(raw.stop_at_time) || null,
    tokenSharePercent: parsePositiveInt(raw.token_share_percent, 40),
    contractSharePercent: parsePositiveInt(raw.contract_share_percent, 60),
    provider,
    model: normalizeAiAuditModel(provider, raw.model),
    contractMinTvlUsd: parsePositiveFloat(raw.contract_min_tvl_usd, 10_000),
    tokenMinPriceUsd: parsePositiveFloat(raw.token_min_price_usd, 0.001),
    requireTokenSync: Boolean(raw.require_token_sync ?? true),
    requireContractSelectors: Boolean(raw.require_contract_selectors ?? true),
    skipSeenContracts: Boolean(raw.skip_seen_contracts ?? true),
    onePerContractPattern: Boolean(raw.one_per_contract_pattern ?? true),
    retryFailedAudits: Boolean(raw.retry_failed_audits ?? true),
    excludeAuditedContracts: Boolean(raw.exclude_audited_contracts ?? true),
    excludeAuditedTokens: Boolean(raw.exclude_audited_tokens ?? true),
  };
}

export function getWebSecurityConfig(): {
  httpsEnabled: boolean;
  tlsCertPath: string;
  tlsKeyPath: string;
} {
  const raw = ensureRuntimeCache().appConfig.web_security ?? {};
  const resolved = resolveTlsPaths(raw.tls_cert_path, raw.tls_key_path);
  return {
    httpsEnabled: Boolean(raw.https_enabled ?? false) || resolved.autoDiscovered,
    tlsCertPath: resolved.tlsCertPath,
    tlsKeyPath: resolved.tlsKeyPath,
  };
}

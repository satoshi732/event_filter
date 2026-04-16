import {
  ContractRegistryRow,
  getContractRegistryMap,
  getKnownContractAddressSet,
  removeContractSelectorTempRows,
  storeContractDeploymentRows,
  storeContractPortfolioRows,
  storeContractsRegistryRows,
} from './repository.js';
import { logger } from '../../utils/logger.js';
import { buildSelectorsTempRows, persistSelectorsTempRows } from '../selectors-manager/index.js';
import { fetchVerifiedContractPattern } from './source-discovery.js';

export interface PersistableContract {
  contractAddr: string;
  linkage: string | null;
  linkType: 'proxy' | 'eip7702' | null;
  label: string;
  review?: string;
  contractSelectorHash?: string | null;
  contractSelectors?: string[];
  contractCodeSize?: number;
  selectorHash: string | null;
  isExploitable: boolean;
  portfolio: string;
  deployedAt?: string | null;
  isAutoAudit?: boolean;
  isManualAudit?: boolean;
  whitelistPatterns: string[];
  selectors: string[];
  codeSize: number;
}

export function getKnownContractSet(chain: string): Set<string> {
  return getKnownContractAddressSet(chain);
}

export function getKnownContractMap(chain: string, addresses: string[]): Map<string, ContractRegistryRow> {
  return getContractRegistryMap(chain, addresses);
}

export function persistNewContracts(input: {
  chain: string;
  rows: PersistableContract[];
}): void {
  if (!input.rows.length) return;
  storeContractsRegistryRows(input.chain, input.rows);

  const selectorRows = buildSelectorsTempRows(
    input.chain,
    input.rows
      .filter((row) => row.selectorHash && row.selectors.length > 0 && !row.label)
      .map((row) => ({
        contractAddr: row.contractAddr,
        selectorHash: row.selectorHash!,
        selectors: row.selectors,
        label: row.label,
        bytecodeSize: row.codeSize,
      })),
  );
  const contractSelectorRows = buildSelectorsTempRows(
    input.chain,
    input.rows
      .filter((row) =>
        row.contractSelectorHash
        && (row.contractSelectors?.length ?? 0) > 0
        && row.contractSelectorHash !== row.selectorHash
        && !row.label,
      )
      .map((row) => ({
        contractAddr: row.contractAddr,
        selectorHash: row.contractSelectorHash!,
        selectors: row.contractSelectors ?? [],
        label: row.label,
        bytecodeSize: row.contractCodeSize ?? 0,
      })),
  );
  persistSelectorsTempRows(input.chain, [...selectorRows, ...contractSelectorRows]);

  logger.info(`[${input.chain}] Contract manager: persisted ${input.rows.length} contract(s)`);
}

export function updateRoundPortfolio(
  chain: string,
  rows: Array<{ contractAddr: string; portfolio: string }>,
): void {
  if (!rows.length) return;
  storeContractPortfolioRows(chain, rows);
  logger.info(`[${chain}] Contract manager: updated total USD for ${rows.length} contract(s)`);
}

export function backfillContractDeployments(
  chain: string,
  rows: Array<{ contractAddr: string; deployedAt: string | null }>,
): void {
  if (!rows.length) return;
  storeContractDeploymentRows(chain, rows);
}

export function backfillContractPatternMetadata(input: {
  chain: string;
  rows: PersistableContract[];
}): void {
  if (!input.rows.length) return;
  storeContractsRegistryRows(input.chain, input.rows);
}

function normalizeLinkType(value: unknown): 'proxy' | 'eip7702' | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'proxy') return 'proxy';
  if (normalized === 'eip7702') return 'eip7702';
  return null;
}

function normalizeAddress(value: unknown): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
}

function resolveContractSelfPattern(existing: ContractRegistryRow) {
  const contractSelectorHash = existing.contractSelectorHash
    ?? (!existing.linkType ? existing.selectorHash : null);
  const contractSelectors = existing.contractSelectors.length
    ? existing.contractSelectors
    : (!existing.linkType ? existing.selectors : []);
  const contractCodeSize = existing.contractCodeSize > 0
    ? existing.contractCodeSize
    : (!existing.linkType ? existing.codeSize : 0);

  return {
    contractSelectorHash,
    contractSelectors,
    contractCodeSize,
  };
}

function registryHasEffectiveSelectors(row: ContractRegistryRow | null | undefined): boolean {
  if (!row) return false;
  return Boolean(
    row.selectorHash
    && ((row.selectors?.length ?? 0) > 0 || (row.contractSelectors?.length ?? 0) > 0),
  );
}

export async function updateManualContractLinkage(input: {
  chain: string;
  contractAddr: string;
  linkType: 'proxy' | 'eip7702' | null;
  linkage: string | null;
}): Promise<ContractRegistryRow> {
  const chain = String(input.chain || '').trim().toLowerCase();
  const contractAddr = normalizeAddress(input.contractAddr);
  if (!chain || !contractAddr) {
    throw new Error('chain and contract address are required');
  }

  const existing = getKnownContractMap(chain, [contractAddr]).get(contractAddr);
  if (!existing) {
    throw new Error(`Contract ${contractAddr} is not registered`);
  }

  const nextLinkType = normalizeLinkType(input.linkType);
  const nextLinkage = nextLinkType ? normalizeAddress(input.linkage) : null;
  if (nextLinkType && !nextLinkage) {
    throw new Error('Implementation address is required');
  }

  const selfPattern = resolveContractSelfPattern(existing);
  let linkedRegistry = nextLinkage
    ? getKnownContractMap(chain, [nextLinkage]).get(nextLinkage) ?? null
    : null;
  const needsLinkedPatternFetch = Boolean(nextLinkType && nextLinkage && !registryHasEffectiveSelectors(linkedRegistry));
  if (needsLinkedPatternFetch && nextLinkage) {
    const fetchedPattern = await fetchVerifiedContractPattern(chain, nextLinkage);
    if (fetchedPattern) {
      storeContractsRegistryRows(chain, [{
        contractAddr: nextLinkage,
        linkage: linkedRegistry?.linkage ?? null,
        linkType: linkedRegistry?.linkType ?? null,
        label: linkedRegistry?.label ?? '',
        review: linkedRegistry?.review ?? '',
        contractSelectorHash: fetchedPattern.selectorHash,
        contractSelectors: fetchedPattern.selectors,
        contractCodeSize: fetchedPattern.codeSize,
        selectorHash: fetchedPattern.selectorHash,
        isExploitable: linkedRegistry?.isExploitable ?? false,
        portfolio: linkedRegistry?.portfolio ?? '{}',
        deployedAt: linkedRegistry?.deployedAt ?? null,
        isAutoAudit: linkedRegistry?.isAutoAudit ?? false,
        isManualAudit: linkedRegistry?.isManualAudit ?? false,
        whitelistPatterns: linkedRegistry?.whitelistPatterns ?? [],
        selectors: fetchedPattern.selectors,
        codeSize: fetchedPattern.codeSize,
      }]);
      linkedRegistry = getKnownContractMap(chain, [nextLinkage]).get(nextLinkage) ?? linkedRegistry;
      logger.info(
        `[${chain}] Contract manager: refreshed selectors for linked contract ${nextLinkage} (${fetchedPattern.selectors.length} selectors)`,
      );
    } else {
      logger.warn(
        `[${chain}] Contract manager: could not derive selectors for linked contract ${nextLinkage}; linkage will be saved without an effective pattern`,
      );
    }
  }

  const nextSelectorHash = nextLinkType
    ? (linkedRegistry?.selectorHash ?? linkedRegistry?.contractSelectorHash ?? null)
    : (selfPattern.contractSelectorHash ?? null);
  const nextSelectors = nextLinkType
    ? (linkedRegistry?.selectors?.length
      ? linkedRegistry.selectors
      : (linkedRegistry?.contractSelectors ?? []))
    : selfPattern.contractSelectors;
  const nextCodeSize = nextLinkType
    ? (linkedRegistry?.codeSize || linkedRegistry?.contractCodeSize || 0)
    : selfPattern.contractCodeSize;

  storeContractsRegistryRows(chain, [{
    contractAddr,
    linkage: nextLinkage,
    linkType: nextLinkType,
    label: existing.label,
    review: existing.review,
    contractSelectorHash: selfPattern.contractSelectorHash ?? null,
    contractSelectors: selfPattern.contractSelectors,
    contractCodeSize: selfPattern.contractCodeSize,
    selectorHash: nextSelectorHash,
    isExploitable: existing.isExploitable,
    portfolio: existing.portfolio,
    deployedAt: existing.deployedAt,
    isAutoAudit: existing.isAutoAudit,
    isManualAudit: existing.isManualAudit,
    whitelistPatterns: linkedRegistry?.whitelistPatterns?.length
      ? linkedRegistry.whitelistPatterns
      : existing.whitelistPatterns,
    selectors: nextSelectors,
    codeSize: nextCodeSize,
  }]);

  const nextSelectorRows = buildSelectorsTempRows(chain, [
    ...(selfPattern.contractSelectorHash && selfPattern.contractSelectors.length ? [{
      contractAddr,
      selectorHash: selfPattern.contractSelectorHash,
      selectors: selfPattern.contractSelectors,
      label: existing.label,
      bytecodeSize: selfPattern.contractCodeSize,
      status: 'pending',
      lastError: null,
    }] : []),
    ...(nextSelectorHash && nextSelectors.length && nextSelectorHash !== selfPattern.contractSelectorHash ? [{
      contractAddr,
      selectorHash: nextSelectorHash,
      selectors: nextSelectors,
      label: existing.label,
      bytecodeSize: nextCodeSize,
      status: 'pending',
      lastError: null,
    }] : []),
  ]);

  if (nextSelectorRows.length) {
    persistSelectorsTempRows(chain, nextSelectorRows);
  }

  const keepHashes = new Set(nextSelectorRows.map((row) => row.selectorHash));
  const staleHashes = [...new Set(
    [existing.selectorHash, existing.contractSelectorHash]
      .map((hash) => String(hash || '').trim())
      .filter(Boolean)
      .filter((hash) => !keepHashes.has(hash)),
  )];
  if (staleHashes.length) {
    removeContractSelectorTempRows(chain, contractAddr, staleHashes);
  }

  logger.info(
    `[${chain}] Contract manager: linkage override saved for ${contractAddr} -> ${nextLinkType ? `${nextLinkType}:${nextLinkage}` : 'plain'}`,
  );

  return getKnownContractMap(chain, [contractAddr]).get(contractAddr) ?? existing;
}

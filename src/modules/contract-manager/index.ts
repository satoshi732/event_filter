import {
  ContractRegistryRow,
  getContractRegistryMap,
  getKnownContractAddressSet,
  storeContractDeploymentRows,
  storeContractPortfolioRows,
  storeContractsRegistryRows,
} from './repository.js';
import { logger } from '../../utils/logger.js';
import { buildSelectorsTempRows, persistSelectorsTempRows } from '../selectors-manager/index.js';

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

import {
  ContractRegistryRow,
  getContractsRegistry,
  getKnownContractAddresses,
  updateContractDeploymentBatch,
  updateContractPortfolioBatch,
  upsertContractsRegistryBatch,
} from '../../db.js';

export type { ContractRegistryRow };

export function getKnownContractAddressSet(chain: string): Set<string> {
  return getKnownContractAddresses(chain);
}

export function getContractRegistryMap(
  chain: string,
  addresses: string[],
): Map<string, ContractRegistryRow> {
  return getContractsRegistry(chain, addresses);
}

export function storeContractsRegistryRows(
  chain: string,
  rows: Array<{
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
  }>,
): void {
  upsertContractsRegistryBatch(chain, rows);
}

export function storeContractPortfolioRows(
  chain: string,
  rows: Array<{ contractAddr: string; portfolio: string }>,
): void {
  updateContractPortfolioBatch(chain, rows);
}

export function storeContractDeploymentRows(
  chain: string,
  rows: Array<{ contractAddr: string; deployedAt: string | null }>,
): void {
  updateContractDeploymentBatch(chain, rows);
}

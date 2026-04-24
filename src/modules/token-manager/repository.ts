import { getTokenRegistry, upsertTokenRegistryBatch } from '../../db.js';

export function getTokenRegistrySnapshot(chain: string, tokens: string[]) {
  return getTokenRegistry(chain, tokens);
}

export function storeTokenRegistryRows(
  chain: string,
  rows: Array<{
    address: string;
    name: string | null;
    symbol: string | null;
    decimals?: number | null;
    tokenKind?: 'fungible' | 'erc721' | 'erc1155' | 'native' | 'unknown' | null;
    priceUsd: number | null;
    created: string | null;
    callsSync: boolean | null;
    selectorHash?: string | null;
    selectors?: string[];
    codeSize?: number;
    seenLabel?: string;
    isNative?: boolean;
  }>,
): void {
  upsertTokenRegistryBatch(chain, rows);
}

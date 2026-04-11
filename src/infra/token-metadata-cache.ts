import {
  getTokenMetadataCache,
  upsertTokenMetadataBatch,
} from '../db.js';

export function readTokenMetadataCache(chain: string, tokens: string[]) {
  return getTokenMetadataCache(chain, tokens);
}

export function storeTokenMetadataCache(
  chain: string,
  rows: Array<{
    token: string;
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    tokenKind?: 'fungible' | 'erc721' | 'erc1155' | 'native' | 'unknown' | null;
    tokenPriceUsd?: number | null;
    isAutoAudited?: boolean;
    isManualAudited?: boolean;
    is_native?: boolean;
    tokenCreatedAt?: string | null;
    tokenCallsSync?: boolean | null;
  }>,
): void {
  upsertTokenMetadataBatch(chain, rows);
}

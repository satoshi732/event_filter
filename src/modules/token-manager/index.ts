import { ContractInfo, getContractInfos } from '../../chainbase/queries.js';
import { getTokenPricesBatch, isFungibleTokenKind, TokenMetadata } from '../../utils/rpc.js';
import { detectSyncCallPattern } from '../analysis/index.js';
import { logger } from '../../utils/logger.js';
import { getTokenRegistrySnapshot, storeTokenRegistryRows } from './repository.js';
import { sanitizeTokenPriceUsd } from '../../utils/token-price.js';

interface TokenFacts {
  tokenCreatedAt: string | null;
  tokenCallsSync: boolean | null;
}

export async function syncTokenRegistryForRound(input: {
  chain: string;
  tokens: string[];
  metadataMap: Map<string, TokenMetadata>;
  tokenFactsMap: Map<string, TokenFacts>;
  nativeTokenRef: string;
}): Promise<Map<string, number | null>> {
  const chain = input.chain.toLowerCase();
  const tokens = [...new Set(input.tokens.map((token) => token.toLowerCase()).filter(Boolean))];
  if (!tokens.length) return new Map();
  const fungibleTokens = tokens.filter((token) => isFungibleTokenKind(input.metadataMap.get(token)?.tokenKind));
  if (!fungibleTokens.length) return new Map();

  const existing = getTokenRegistrySnapshot(chain, fungibleTokens);

  const missingTokens = fungibleTokens.filter((token) => !existing.has(token));
  const missingContracts = missingTokens.filter((token) => token !== input.nativeTokenRef);
  const missingInfos = missingContracts.length
    ? await getContractInfos(chain, missingContracts)
    : new Map<string, ContractInfo>();

  for (const token of missingTokens) {
    if (token === input.nativeTokenRef) continue;
    const info = missingInfos.get(token);
    const currentFacts = input.tokenFactsMap.get(token) ?? { tokenCreatedAt: null, tokenCallsSync: null };
    input.tokenFactsMap.set(token, {
      tokenCreatedAt: info?.block_timestamp ?? currentFacts.tokenCreatedAt,
      tokenCallsSync: info?.bytecode ? detectSyncCallPattern(info.bytecode) : currentFacts.tokenCallsSync,
    });
  }

  const prices = await getTokenPricesBatch(chain, fungibleTokens);

  const rows = fungibleTokens.map((token) => {
    const meta = input.metadataMap.get(token) ?? {
      name: null,
      symbol: null,
      decimals: null,
      priceUsd: null,
      tokenKind: null,
      isAutoAudited: false,
      isManualAudited: false,
    };
    const price = sanitizeTokenPriceUsd(prices.get(token) ?? meta.priceUsd ?? null);
    const isExisting = existing.has(token);
    if (isExisting) {
      return {
        address: token,
        name: null,
        symbol: null,
        decimals: meta.decimals,
        tokenKind: meta.tokenKind ?? null,
        priceUsd: price,
        created: null,
        callsSync: null,
        isNative: token === input.nativeTokenRef,
      };
    }

    const facts = input.tokenFactsMap.get(token) ?? { tokenCreatedAt: null, tokenCallsSync: null };
    return {
      address: token,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      tokenKind: meta.tokenKind ?? null,
      priceUsd: price,
      created: facts.tokenCreatedAt,
      callsSync: facts.tokenCallsSync,
      isNative: token === input.nativeTokenRef,
    };
  });

  storeTokenRegistryRows(chain, rows);
  logger.info(`[${chain}] Token manager: synced ${rows.length} token(s), missing inserted ${missingTokens.length}`);
  return prices;
}

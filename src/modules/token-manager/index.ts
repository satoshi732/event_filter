import { ContractInfo, getContractInfos } from '../../chainbase/queries.js';
import { getTokenPricesBatch, isFungibleTokenKind, TokenMetadata } from '../../utils/rpc.js';
import { detectSyncCallPattern, resolvePatternHash } from '../analysis/index.js';
import { logger } from '../../utils/logger.js';
import { getTokenRegistrySnapshot, storeTokenRegistryRows } from './repository.js';
import { sanitizeTokenPriceUsd } from '../../utils/token-price.js';
import { extractSelectors } from '../../analyzer/bytecode.js';
import { buildSelectorsTempRows, listSeenSelectorEntries, matchSeenEntryBySimilarity, persistSelectorsTempRows } from '../selectors-manager/index.js';

interface TokenFacts {
  tokenCreatedAt: string | null;
  tokenCallsSync: boolean | null;
}

function hasTokenPatternMetadata(row: {
  selectorHash?: string | null;
  selectors?: string[];
  codeSize?: number;
} | null | undefined): boolean {
  return Boolean(
    row?.selectorHash
    || ((row?.selectors?.length ?? 0) > 0)
    || ((row?.codeSize ?? 0) > 0),
  );
}

function normalizeSelectors(selectors: string[]): string[] {
  return [...new Set((selectors || []).map((selector) => String(selector || '').trim().toLowerCase()).filter(Boolean))].sort();
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
  const seenEntries = listSeenSelectorEntries();

  const missingTokens = fungibleTokens.filter((token) => !existing.has(token));
  const tokensMissingPattern = fungibleTokens.filter((token) => (
    token !== input.nativeTokenRef
    && !hasTokenPatternMetadata(existing.get(token))
  ));
  const infoTargets = [...new Set([
    ...missingTokens.filter((token) => token !== input.nativeTokenRef),
    ...tokensMissingPattern,
  ])];
  const infoMap = infoTargets.length
    ? await getContractInfos(chain, infoTargets)
    : new Map<string, ContractInfo>();

  for (const token of missingTokens) {
    if (token === input.nativeTokenRef) continue;
    const info = infoMap.get(token);
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
    const existingRow = existing.get(token);
    const isExisting = Boolean(existingRow);
    const info = infoMap.get(token);
    const bytecode = String(info?.bytecode || '').trim().toLowerCase();
    const selectors = normalizeSelectors(
      existingRow?.selectors?.length
        ? existingRow.selectors
        : (bytecode ? (extractSelectors(bytecode) ?? []) : []),
    );
    const codeSize = existingRow?.codeSize && existingRow.codeSize > 0
      ? existingRow.codeSize
      : (bytecode ? Math.floor(bytecode.length / 2) : 0);
    const seenEntry = selectors.length ? matchSeenEntryBySimilarity(selectors, codeSize, seenEntries) : undefined;
    const selectorHash = token === input.nativeTokenRef
      ? null
      : (seenEntry?.hash
        ?? ((selectors.length || bytecode)
          ? resolvePatternHash(selectors, bytecode, `token:${token}`)
          : (existingRow?.selectorHash ?? null)));
    const seenLabel = token === input.nativeTokenRef ? '' : String(seenEntry?.label || '').trim();

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
        selectorHash,
        selectors,
        codeSize,
        seenLabel,
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
      selectorHash,
      selectors,
      codeSize,
      seenLabel,
      isNative: token === input.nativeTokenRef,
    };
  });

  storeTokenRegistryRows(chain, rows);
  const pendingPatternRows = buildSelectorsTempRows(
    chain,
    rows
      .filter((row) => (
        !row.isNative
        && !String(row.seenLabel || '').trim()
        && Boolean(row.selectorHash)
        && Array.isArray(row.selectors)
        && row.selectors.length > 0
        && !existing.get(row.address)?.isManualAudited
      ))
      .map((row) => ({
        contractAddr: row.address,
        selectorHash: row.selectorHash!,
        selectors: row.selectors || [],
        label: '',
        bytecodeSize: row.codeSize ?? 0,
        status: 'pending',
        lastError: null,
      })),
  );
  persistSelectorsTempRows(chain, pendingPatternRows);
  logger.info(`[${chain}] Token manager: synced ${rows.length} token(s), missing inserted ${missingTokens.length}`);
  return prices;
}

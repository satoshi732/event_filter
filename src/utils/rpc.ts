import axios from 'axios';
import {
  getChainConfig,
  getPancakeSwapPriceLimiterConfig,
} from '../config.js';
import { logger } from './logger.js';
import { readTokenMetadataCache, storeTokenMetadataCache } from '../infra/token-metadata-cache.js';
import { sanitizeTokenPriceUsd } from './token-price.js';
import { TokenKind } from '../db/types.js';

const RPC_TIMEOUT_MS = 20_000;
const MULTICALL_MAX_SUBCALLS = 96;
const AGGREGATE3_SELECTOR = '82ad56cb';
const PANCAKESWAP_PRICE_API_BASE = 'https://wallet-api.pancakeswap.com/v1/prices/list';
const PANCAKESWAP_NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';
const PANCAKESWAP_PRICE_BATCH_SIZE = 50;
let pancakeLimiterLock: Promise<void> = Promise.resolve();
const pancakePriceRequestTimestamps: number[] = [];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDnsError(err: unknown): boolean {
  return /EAI_AGAIN|ENOTFOUND|EAI_FAIL|getaddrinfo/i.test(errorMessage(err));
}

function isRateLimitError(err: unknown): boolean {
  if (axios.isAxiosError(err)) {
    return err.response?.status === 429;
  }
  return false;
}

function getRetryAfterMs(err: unknown, fallbackMs: number): number {
  if (!axios.isAxiosError(err)) return fallbackMs;
  const retryAfter = err.response?.headers?.['retry-after'];
  const value = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
  if (value == null) return fallbackMs;

  const seconds = Number(String(value).trim());
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.floor(seconds * 1000);
  }
  return fallbackMs;
}

function strip0x(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
}

function pad32(hex: string): string {
  return strip0x(hex).padStart(64, '0');
}

function addressArg(address: string): string {
  return pad32(address.toLowerCase().replace(/^0x/, ''));
}

function decodeUint256(hex: string): bigint {
  const raw = strip0x(hex);
  if (!raw) return 0n;
  const word = raw.length > 64 ? raw.slice(0, 64) : raw;
  return BigInt(`0x${word}`);
}

function encodeUint256(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, '0');
}

function encodeBool(value: boolean): string {
  return encodeUint256(value ? 1 : 0);
}

function encodeAddress(address: string): string {
  return pad32(address.toLowerCase().replace(/^0x/, ''));
}

function encodeBytes(hex: string): string {
  const raw = strip0x(hex);
  const paddedLength = Math.ceil(raw.length / 64) * 64;
  return encodeUint256(raw.length / 2) + raw.padEnd(paddedLength, '0');
}

function decodeWord(hex: string, byteOffset: number): string {
  const start = byteOffset * 2;
  return hex.slice(start, start + 64);
}

function decodeBytes(hex: string, byteOffset: number): string {
  const len = Number(BigInt(`0x${decodeWord(hex, byteOffset)}`));
  const start = (byteOffset + 32) * 2;
  return '0x' + hex.slice(start, start + len * 2);
}

function decodeBytes32String(hex: string): string | null {
  const raw = strip0x(hex).slice(0, 64);
  if (!raw) return null;
  const text = Buffer.from(raw, 'hex').toString('utf8').replace(/\u0000+$/g, '').trim();
  return text || null;
}

function decodeAbiString(hex: string): string | null {
  const raw = strip0x(hex);
  if (!raw) return null;

  if (raw.length === 64) return decodeBytes32String(raw);
  if (raw.length < 128) return decodeBytes32String(raw);

  try {
    const offset = Number(BigInt(`0x${raw.slice(0, 64)}`));
    const start = offset * 2;
    if (!Number.isFinite(offset) || raw.length < start + 64) return decodeBytes32String(raw);

    const len = Number(BigInt(`0x${raw.slice(start, start + 64)}`));
    const dataStart = start + 64;
    const dataEnd = dataStart + len * 2;
    if (!Number.isFinite(len) || raw.length < dataEnd) return decodeBytes32String(raw);

    const text = Buffer.from(raw.slice(dataStart, dataEnd), 'hex')
      .toString('utf8')
      .replace(/\u0000+$/g, '')
      .trim();
    return text || null;
  } catch {
    return decodeBytes32String(raw);
  }
}

export interface TokenMetadata {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  priceUsd: number | null;
  tokenKind: TokenKind | null;
  isAutoAudited: boolean;
  isManualAudited: boolean;
}

export function getNativeTokenRef(chain: string): string {
  return `native:${chain.toLowerCase()}`;
}

function isNativeToken(chain: string, token: string): boolean {
  return token.toLowerCase() === getNativeTokenRef(chain);
}

function getNativeTokenMetadata(chain: string): TokenMetadata {
  const nativeCurrency = getChainConfig(chain).nativeCurrency;
  return {
    name: nativeCurrency.name,
    symbol: nativeCurrency.symbol,
    decimals: nativeCurrency.decimals,
    priceUsd: null,
    tokenKind: 'native',
    isAutoAudited: false,
    isManualAudited: false,
  };
}

export function isFungibleTokenKind(kind: TokenKind | null | undefined): boolean {
  return kind === 'fungible' || kind === 'native' || kind == null || kind === 'unknown';
}

function isAddressLike(value: string): boolean {
  return /^0x[a-f0-9]{40}$/i.test(value);
}

interface MulticallRequest {
  target: string;
  allowFailure: boolean;
  callData: string;
}

interface MulticallResponse {
  success: boolean;
  returnData: string;
}

interface RpcCallOptions {
  allowExecutionRevert?: boolean;
}

export class RpcRotator {
  private readonly urls: string[];
  private idx = 0;

  constructor(urls: string[]) {
    if (!urls.length) throw new Error('RpcRotator: urls array is empty');
    this.urls = urls;
  }

  private get current(): string {
    return this.urls[this.idx];
  }

  private advance(): void {
    this.idx = (this.idx + 1) % this.urls.length;
  }

  async call<T>(fn: (url: string) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      const url = this.current;
      try {
        return await fn(url);
      } catch (err) {
        lastErr = err;
        const message = errorMessage(err);
        logger.warn(`RPC failed [${url}] — ${message} — rotating (${attempt + 1}/${this.urls.length})`);
        this.advance();
      }
    }
    throw lastErr;
  }
}

const rotators = new Map<string, RpcRotator>();
const metadataCache = new Map<string, Promise<TokenMetadata>>();
const balanceCache = new Map<string, Promise<string | null>>();
const disabledRpcUrls = new Map<string, string>();

function getRotator(chain: string): RpcRotator {
  const key = chain.toLowerCase();
  let rotator = rotators.get(key);
  if (!rotator) {
    const cfg = getChainConfig(chain);
    const urls = cfg.rpcUrls;
    if (!urls.length) {
      throw new Error(`No assembled RPC URLs available for ${chain} (rpc_network=${cfg.rpcNetwork || 'unset'})`);
    }
    rotator = new RpcRotator(urls);
    rotators.set(key, rotator);
    logger.info(`[${chain}] RPC rotator created (${urls.length} URLs)`);
  }
  return rotator;
}

async function rpcCall<T = unknown>(chain: string, method: string, params: unknown[]): Promise<T> {
  const rotator = getRotator(chain);
  return rpcCallWithOptions<T>(chain, method, params, {});
}

export async function getContractBytecode(chain: string, address: string): Promise<string> {
  const result = await rpcCall<string>(chain, 'eth_getCode', [address.toLowerCase(), 'latest']);
  return String(result || '').trim().toLowerCase();
}

export async function getContractCodeSize(chain: string, address: string): Promise<number> {
  const normalized = strip0x(await getContractBytecode(chain, address));
  if (!normalized) return 0;
  return Math.floor(normalized.length / 2);
}

async function rpcCallWithOptions<T = unknown>(
  chain: string,
  method: string,
  params: unknown[],
  options: RpcCallOptions,
): Promise<T> {
  const rotator = getRotator(chain);
  return rotator.call(async (url) => {
    if (disabledRpcUrls.has(url)) {
      throw new Error(`RPC URL disabled: ${disabledRpcUrls.get(url)}`);
    }

    const payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    };

    const post = async (): Promise<T> => {
      const res = await axios.post(endpoint, payload, {
        timeout: RPC_TIMEOUT_MS,
        proxy: false,
        headers: { 'content-type': 'application/json' },
      });

      if (res.data?.error) {
        const message = res.data.error.message ?? `RPC ${method} failed`;
        if (options.allowExecutionRevert && /execution reverted/i.test(message)) {
          return res.data?.result as T;
        }
        throw new Error(message);
      }
      return res.data?.result as T;
    };
    const endpoint = url;
    return post();
  }).catch((err) => {
    const message = errorMessage(err);
    const urlMatch = message.match(/https?:\/\/[^\s]+/);
    if (/status code 401/i.test(message) && urlMatch) {
      disabledRpcUrls.set(urlMatch[0], '401 unauthorized');
    }
    throw err;
  });
}

async function ethCall(chain: string, to: string, data: string): Promise<string> {
  return rpcCall<string>(chain, 'eth_call', [
    { to, data },
    'latest',
  ]);
}

async function ethCallAllowRevert(chain: string, to: string, data: string): Promise<string | null> {
  try {
    return await rpcCallWithOptions<string>(chain, 'eth_call', [
      { to, data },
      'latest',
    ], { allowExecutionRevert: true });
  } catch (err) {
    if (/execution reverted/i.test(errorMessage(err))) return null;
    throw err;
  }
}

async function callUint256(chain: string, to: string, selector: string, arg?: string): Promise<bigint> {
  const result = await ethCall(chain, to, `0x${selector}${arg ?? ''}`);
  return decodeUint256(result);
}

async function callString(chain: string, to: string, selector: string): Promise<string | null> {
  const result = await ethCall(chain, to, `0x${selector}`);
  return decodeAbiString(result);
}

function encodeAggregate3Calls(calls: MulticallRequest[]): string {
  const tupleTails = calls.map((call) => {
    const bytesTail = encodeBytes(call.callData);
    return encodeAddress(call.target)
      + encodeBool(call.allowFailure)
      + encodeUint256(96)
      + bytesTail;
  });

  let tupleOffset = calls.length * 32;
  const tupleHeads = tupleTails.map((tail) => {
    const current = encodeUint256(tupleOffset);
    tupleOffset += tail.length / 2;
    return current;
  });

  const arrayEncoding = encodeUint256(calls.length) + tupleHeads.join('') + tupleTails.join('');
  return `0x${AGGREGATE3_SELECTOR}${encodeUint256(32)}${arrayEncoding}`;
}

function decodeAggregate3Result(result: string): MulticallResponse[] {
  const raw = strip0x(result);
  if (!raw) return [];

  const arrayOffset = Number(BigInt(`0x${decodeWord(raw, 0)}`));
  const arrayStart = arrayOffset;
  const arrayLength = Number(BigInt(`0x${decodeWord(raw, arrayStart)}`));
  const tupleHeadsStart = arrayStart + 32;
  const out: MulticallResponse[] = [];

  for (let i = 0; i < arrayLength; i++) {
    const tupleOffset = Number(BigInt(`0x${decodeWord(raw, tupleHeadsStart + i * 32)}`));
    const tupleStart = tupleHeadsStart + tupleOffset;
    const success = BigInt(`0x${decodeWord(raw, tupleStart)}`) !== 0n;
    const returnDataOffset = Number(BigInt(`0x${decodeWord(raw, tupleStart + 32)}`));
    const returnData = decodeBytes(raw, tupleStart + returnDataOffset);
    out.push({ success, returnData });
  }

  return out;
}

async function multicallAggregate3(chain: string, calls: MulticallRequest[]): Promise<MulticallResponse[]> {
  if (!calls.length) return [];
  const multicall3 = getChainConfig(chain).multicall3Address;
  const payload = encodeAggregate3Calls(calls);
  const result = await ethCall(chain, multicall3, payload);
  return decodeAggregate3Result(result);
}

async function executeWithBatchFallback<R extends MulticallRequest, T>(
  chain: string,
  requests: R[],
  onSuccess: (req: R, returnData: string) => T,
  onSubcallFailure: (req: R) => T,
  onBatchFailure: (req: R) => Promise<T>,
): Promise<T[]> {
  try {
    const responses = await multicallAggregate3(chain, requests);
    return Promise.all(responses.map(async (res, idx) => {
      const req = requests[idx];
      if (res?.success) return onSuccess(req, res.returnData);
      return onSubcallFailure(req);
    }));
  } catch (err) {
    logger.warn(`[${chain}] Multicall batch failed, falling back to direct RPC: ${(err as Error).message}`);
    return Promise.all(requests.map(onBatchFailure));
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withPancakeLimiter<T>(task: () => Promise<T>): Promise<T> {
  const run = pancakeLimiterLock.then(task, task);
  pancakeLimiterLock = run.then(() => undefined, () => undefined);
  return run;
}

async function acquirePancakePriceRateSlot(): Promise<void> {
  await withPancakeLimiter(async () => {
    while (true) {
      const limiterConfig = getPancakeSwapPriceLimiterConfig();
      const maxReqPerSecond = limiterConfig.maxReqPerSecond;
      const maxReqPerMinute = limiterConfig.maxReqPerMinute;
      const now = Date.now();
      const minuteWindowStart = now - 60_000;
      while (pancakePriceRequestTimestamps.length && pancakePriceRequestTimestamps[0] <= minuteWindowStart) {
        pancakePriceRequestTimestamps.shift();
      }

      const secondWindowStart = now - 1_000;
      const firstSecondIndex = pancakePriceRequestTimestamps.findIndex((ts) => ts > secondWindowStart);
      const secondCount = firstSecondIndex === -1
        ? 0
        : pancakePriceRequestTimestamps.length - firstSecondIndex;

      const minuteCount = pancakePriceRequestTimestamps.length;
      const secondWaitMs = secondCount >= maxReqPerSecond && firstSecondIndex !== -1
        ? Math.max(0, pancakePriceRequestTimestamps[firstSecondIndex] + 1_000 - now)
        : 0;
      const minuteWaitMs = minuteCount >= maxReqPerMinute
        ? Math.max(0, pancakePriceRequestTimestamps[0] + 60_000 - now)
        : 0;
      const waitMs = Math.max(secondWaitMs, minuteWaitMs);

      if (waitMs <= 0) {
        pancakePriceRequestTimestamps.push(Date.now());
        return;
      }

      await sleep(waitMs + 5);
    }
  });
}

async function fetchPancakePriceBatch(url: string): Promise<Record<string, unknown>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await acquirePancakePriceRateSlot();
      const res = await axios.get<Record<string, unknown>>(url, {
        timeout: RPC_TIMEOUT_MS,
        headers: { accept: 'application/json' },
      });
      return res.data ?? {};
    } catch (err) {
      lastErr = err;
      if (attempt === 4) throw err;

      if (isRateLimitError(err)) {
        const backoffMs = getRetryAfterMs(err, 1_500 * (attempt + 1));
        logger.warn(`PancakeSwap price API rate-limited (429), backing off ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }

      if (!isDnsError(err)) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

function encodeSupportsInterface(interfaceId: string): string {
  return `0x01ffc9a7${pad32(strip0x(interfaceId).padStart(8, '0'))}`;
}

async function detectTokenKindsBatch(chain: string, tokens: string[]): Promise<Map<string, TokenKind>> {
  const normalized = [...new Set(tokens.map((token) => token.toLowerCase()).filter(Boolean))];
  const out = new Map<string, TokenKind>();

  normalized
    .filter((token) => isNativeToken(chain, token))
    .forEach((token) => out.set(token, 'native'));

  const contractTokens = normalized.filter((token) => !isNativeToken(chain, token) && isAddressLike(token));
  if (!contractTokens.length) return out;

  type KindCheck = 'erc721' | 'erc1155';
  interface Descriptor extends MulticallRequest { token: string; check: KindCheck }

  const requests: Descriptor[] = contractTokens.flatMap((token) => ([
    { token, check: 'erc721' as const, target: token, allowFailure: true, callData: encodeSupportsInterface('80ac58cd') },
    { token, check: 'erc1155' as const, target: token, allowFailure: true, callData: encodeSupportsInterface('d9b67a26') },
  ]));

  const flags = new Map<string, { erc721: boolean; erc1155: boolean }>();
  const setFlag = (token: string, check: KindCheck, supported: boolean) => {
    const current = flags.get(token) ?? { erc721: false, erc1155: false };
    current[check] = supported;
    flags.set(token, current);
  };

  const decodeSupported = (value: string | null | undefined): boolean => {
    if (!value || value === '0x') return false;
    try {
      return decodeUint256(value) !== 0n;
    } catch {
      return false;
    }
  };

  for (const batch of chunk(requests, MULTICALL_MAX_SUBCALLS)) {
    const results = await executeWithBatchFallback(
      chain,
      batch,
      (req, returnData) => ({ req, supported: decodeSupported(returnData) }),
      (req) => ({ req, supported: false }),
      async (req) => {
        try {
          const value = await ethCallAllowRevert(chain, req.token, req.callData);
          return { req, supported: decodeSupported(value) };
        } catch {
          return { req, supported: false };
        }
      },
    );

    for (const { req, supported } of results) {
      setFlag(req.token, req.check, supported);
    }
  }

  for (const token of contractTokens) {
    const detected = flags.get(token);
    if (detected?.erc1155) out.set(token, 'erc1155');
    else if (detected?.erc721) out.set(token, 'erc721');
    else out.set(token, 'fungible');
  }

  return out;
}

export async function getTokenMetadata(chain: string, token: string): Promise<TokenMetadata> {
  const map = await getTokenMetadataBatch(chain, [token]);
  return map.get(token.toLowerCase()) ?? { name: null, symbol: null, decimals: null, priceUsd: null, tokenKind: null, isAutoAudited: false, isManualAudited: false };
}

export async function getTokenBalance(chain: string, token: string, owner: string): Promise<string | null> {
  const map = await getTokenBalancesBatch(chain, [{ token, owner }]);
  return map.get(`${token.toLowerCase()}:${owner.toLowerCase()}`) ?? null;
}

export async function getTokenPricesBatch(
  chain: string,
  tokens: string[],
): Promise<Map<string, number | null>> {
  const normalized = [...new Set(tokens.map(token => token.toLowerCase()).filter(Boolean))];
  const out = new Map<string, number | null>(normalized.map((token) => [token, null]));
  if (!normalized.length) return out;

  const chainId = getChainConfig(chain).chainId;
  const entries = normalized
    .map((token) => ({
      token,
      address: isNativeToken(chain, token) ? PANCAKESWAP_NATIVE_TOKEN_ADDRESS : token,
    }))
    .filter((entry) => isAddressLike(entry.address));

  if (!entries.length) return out;

  for (const batch of chunk(entries, PANCAKESWAP_PRICE_BATCH_SIZE)) {
    const pairs = batch.map(({ address }) => `${chainId}:${address}`);
    const encodedPairs = encodeURIComponent(pairs.join(','));
    const url = `${PANCAKESWAP_PRICE_API_BASE}/${encodedPairs}`;

    try {
      const payload = await fetchPancakePriceBatch(url);
      const normalizedPayload = new Map<string, unknown>(
        Object.entries(payload).map(([key, value]) => [key.toLowerCase(), value]),
      );

      for (const { token, address } of batch) {
        const raw = normalizedPayload.get(`${chainId}:${address}`.toLowerCase());
        const numeric = typeof raw === 'number' ? raw : Number(raw);
        out.set(token, sanitizeTokenPriceUsd(numeric));
      }
    } catch (err) {
      logger.warn(`[${chain}] PancakeSwap price fetch failed (${batch.length} token(s)): ${errorMessage(err)}`);
    }
  }

  return out;
}

export async function getTokenMetadataBatch(chain: string, tokens: string[]): Promise<Map<string, TokenMetadata>> {
  const normalized = [...new Set(tokens.map(token => token.toLowerCase()))];

  const hasUsableMetadata = (metadata: TokenMetadata | null | undefined): boolean =>
    Boolean(metadata) && (
      metadata?.name != null
      || metadata?.symbol != null
      || metadata?.decimals != null
    );

  const cached = readTokenMetadataCache(chain, normalized);
  cached.forEach((row, token) => {
    const cacheKey = `${chain}:${token}`;
    const metadata: TokenMetadata = {
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals,
      priceUsd: sanitizeTokenPriceUsd(row.tokenPriceUsd),
      tokenKind: row.tokenKind ?? null,
      isAutoAudited: row.isAutoAudited,
      isManualAudited: row.isManualAudited,
    };
    if (!metadataCache.has(cacheKey) && hasUsableMetadata(metadata)) {
      metadataCache.set(cacheKey, Promise.resolve({
        name: metadata.name,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        priceUsd: metadata.priceUsd,
        tokenKind: metadata.tokenKind,
        isAutoAudited: metadata.isAutoAudited,
        isManualAudited: metadata.isManualAudited,
      }));
    }
  });

  const nativeTokens = normalized.filter(token => isNativeToken(chain, token));
  const nativeToPersist: Array<{ token: string; name: string | null; symbol: string | null; decimals: number | null; tokenKind?: TokenKind | null; isAutoAudited?: boolean; isManualAudited?: boolean; is_native: boolean }> = [];
  nativeTokens.forEach((token) => {
    const cacheKey = `${chain}:${token}`;
    if (!metadataCache.has(cacheKey)) {
      const metadata = getNativeTokenMetadata(chain);
      metadataCache.set(cacheKey, Promise.resolve(metadata));
      nativeToPersist.push({
        token,
        name: metadata.name,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        tokenKind: metadata.tokenKind,
        isAutoAudited: metadata.isAutoAudited,
        isManualAudited: metadata.isManualAudited,
        is_native: true,
      });
    }
  });
  storeTokenMetadataCache(chain, nativeToPersist);

  const missing: string[] = [];
  const missingKinds: string[] = [];
  for (const token of normalized) {
    if (isNativeToken(chain, token)) continue;
    const cacheKey = `${chain}:${token}`;
    const cachedPromise = metadataCache.get(cacheKey);
    const cachedValue = cachedPromise ? await cachedPromise : null;
    if (!hasUsableMetadata(cachedValue)) {
      missing.push(token);
      continue;
    }
    if ((cachedValue?.tokenKind == null || cachedValue.tokenKind === 'unknown') && isAddressLike(token)) {
      missingKinds.push(token);
    }
  }

  if (missing.length) {
    type Kind = 'name' | 'symbol' | 'decimals';
    interface Descriptor extends MulticallRequest { token: string; kind: Kind }

    const drafts = new Map<string, TokenMetadata>();
    missing.forEach((token) => {
      drafts.set(token, {
        name: null,
        symbol: null,
        decimals: null,
        priceUsd: sanitizeTokenPriceUsd(cached.get(token)?.tokenPriceUsd ?? null),
        tokenKind: cached.get(token)?.tokenKind ?? null,
        isAutoAudited: cached.get(token)?.isAutoAudited ?? false,
        isManualAudited: cached.get(token)?.isManualAudited ?? false,
      });
    });

    const requests: Descriptor[] = missing.flatMap((token) => ([
      { token, kind: 'name' as const, target: token, allowFailure: true, callData: '0x06fdde03' },
      { token, kind: 'symbol' as const, target: token, allowFailure: true, callData: '0x95d89b41' },
      { token, kind: 'decimals' as const, target: token, allowFailure: true, callData: '0x313ce567' },
    ]));

    for (const batch of chunk(requests, MULTICALL_MAX_SUBCALLS)) {
      const results = await executeWithBatchFallback(chain, batch,
        (req, returnData) => ({ req, value: returnData }),
        (req) => ({ req, value: '0x' }),
        async (req) => {
          try {
            const selector =
              req.kind === 'name' ? '06fdde03' :
              req.kind === 'symbol' ? '95d89b41' :
              '313ce567';
            const value = await ethCallAllowRevert(chain, req.target, `0x${selector}`);
            return { req, value };
          } catch {
            return { req, value: '0x' };
          }
        });

      for (const { req, value } of results) {
        const draft = drafts.get(req.token)!;
        if (!value || value === '0x') continue;

        if (req.kind === 'decimals') {
          const decoded = Number(decodeUint256(value));
          draft.decimals = Number.isFinite(decoded) ? decoded : null;
        } else if (req.kind === 'name') {
          draft.name = decodeAbiString(value);
        } else {
          draft.symbol = decodeAbiString(value);
        }
      }
    }

    const detectedKinds = await detectTokenKindsBatch(chain, missing);
    for (const token of missing) {
      drafts.get(token)!.tokenKind = detectedKinds.get(token) ?? 'unknown';
    }

    storeTokenMetadataCache(chain, missing.map((token) => {
      const metadata = drafts.get(token)!;
      return {
        token,
        name: metadata.name,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        tokenKind: metadata.tokenKind,
        isAutoAudited: metadata.isAutoAudited,
        isManualAudited: metadata.isManualAudited,
        is_native: false,
      };
    }));

    for (const token of missing) {
      metadataCache.set(`${chain}:${token}`, Promise.resolve(drafts.get(token)!));
    }
  }

  if (missingKinds.length) {
    const detectedKinds = await detectTokenKindsBatch(chain, missingKinds);
    for (const token of missingKinds) {
      const cacheKey = `${chain}:${token}`;
      const current = await metadataCache.get(cacheKey);
      if (!current) continue;
      const next: TokenMetadata = {
        ...current,
        tokenKind: detectedKinds.get(token) ?? current.tokenKind ?? 'unknown',
      };
      metadataCache.set(cacheKey, Promise.resolve(next));
      storeTokenMetadataCache(chain, [{
        token,
        name: next.name,
        symbol: next.symbol,
        decimals: next.decimals,
        tokenKind: next.tokenKind,
        tokenPriceUsd: next.priceUsd,
        is_native: false,
      }]);
    }
  }

  const out = new Map<string, TokenMetadata>();
  for (const token of normalized) {
    const value = await metadataCache.get(`${chain}:${token}`);
    out.set(token, value ?? { name: null, symbol: null, decimals: null, priceUsd: null, tokenKind: null, isAutoAudited: false, isManualAudited: false });
  }
  return out;
}

export async function getTokenBalancesBatch(
  chain: string,
  pairs: Array<{ token: string; owner: string }>,
): Promise<Map<string, string | null>> {
  const normalized = [...new Map(
    pairs.map(({ token, owner }) => {
      const t = token.toLowerCase();
      const o = owner.toLowerCase();
      return [`${t}:${o}`, { token: t, owner: o }];
    }),
  ).values()];

  const missing = normalized.filter(({ token, owner }) => !balanceCache.has(`${chain}:${token}:${owner}`));
  const nativeMissing = missing.filter(({ token }) => isNativeToken(chain, token));
  const ercMissing = missing.filter(({ token }) => !isNativeToken(chain, token));

  if (nativeMissing.length) {
    await Promise.all(nativeMissing.map(async ({ token, owner }) => {
      const cacheKey = `${chain}:${token}:${owner}`;
      try {
        const value = await rpcCall<string>(chain, 'eth_getBalance', [owner, 'latest']);
        const decoded = value ? decodeUint256(value).toString() : null;
        balanceCache.set(cacheKey, Promise.resolve(decoded));
      } catch {
        balanceCache.set(cacheKey, Promise.resolve(null));
      }
    }));
  }

  if (ercMissing.length) {
    interface Descriptor extends MulticallRequest { token: string; owner: string }

    const requests: Descriptor[] = ercMissing.map(({ token, owner }) => ({
      token,
      owner,
      target: token,
      allowFailure: true,
      callData: `0x70a08231${addressArg(owner)}`,
    }));

    for (const batch of chunk(requests, MULTICALL_MAX_SUBCALLS)) {
      const results = await executeWithBatchFallback(chain, batch,
        (req, returnData) => ({ req, value: returnData }),
        (req) => ({ req, value: '0x' }),
        async (req) => {
          try {
            const value = await ethCallAllowRevert(chain, req.token, `0x70a08231${addressArg(req.owner)}`);
            return { req, value };
          } catch {
            return { req, value: '0x' };
          }
        });

      for (const { req, value } of results) {
        const cacheKey = `${chain}:${req.token}:${req.owner}`;
        const decoded = value && value !== '0x' ? decodeUint256(value).toString() : null;
        balanceCache.set(cacheKey, Promise.resolve(decoded));
      }
    }
  }

  const out = new Map<string, string | null>();
  for (const { token, owner } of normalized) {
    out.set(`${token}:${owner}`, await balanceCache.get(`${chain}:${token}:${owner}`)!);
  }
  return out;
}

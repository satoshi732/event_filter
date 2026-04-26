import { getChainConfig } from '../../config.js';
import { getLatestBlock, getTransfers, getValueTraces, TransferRow, TraceRow } from '../../chainbase/queries.js';
import { getLatestBlockNumber, getTransferLogs } from '../../utils/rpc.js';
import { logger } from '../../utils/logger.js';
import { storeRawRoundSnapshot } from './repository.js';

export interface RawRoundSnapshot {
  chain: string;
  roundId: string;
  blockFrom: number;
  blockTo: number;
  transfers: TransferRow[];
  traces: TraceRow[];
}

export interface RawRoundRangeInput {
  fromBlock?: number | null;
  toBlock?: number | null;
  deltaBlocks?: number | null;
}

function makeRoundId(chain: string, blockFrom: number, blockTo: number): string {
  return `${chain.toLowerCase()}:${blockFrom}:${blockTo}`;
}

function sanitizeRequestedBlock(value: number | null | undefined): number | null {
  if (!Number.isFinite(value) || value == null) return null;
  return Math.max(0, Math.floor(value));
}

function sanitizeRequestedDelta(value: number | null | undefined): number | null {
  if (!Number.isFinite(value) || value == null) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function resolveRoundRange(
  latestBlock: number,
  blocksPerScan: number,
  requestedRange: RawRoundRangeInput = {},
): { blockFrom: number; blockTo: number } {
  const delta = sanitizeRequestedDelta(requestedRange.deltaBlocks) ?? Math.max(1, Math.floor(blocksPerScan));
  const requestedFrom = sanitizeRequestedBlock(requestedRange.fromBlock);
  const requestedTo = sanitizeRequestedBlock(requestedRange.toBlock);

  if (requestedFrom != null && requestedTo != null) {
    const blockFrom = Math.min(requestedFrom, latestBlock);
    const boundedUpper = Math.min(latestBlock, Math.max(requestedTo, blockFrom));
    return {
      blockFrom,
      blockTo: Math.min(boundedUpper, blockFrom + delta),
    };
  }

  if (requestedFrom != null) {
    const blockFrom = Math.min(requestedFrom, latestBlock);
    return {
      blockFrom,
      blockTo: Math.min(latestBlock, blockFrom + delta),
    };
  }

  if (requestedTo != null) {
    const lowerBound = Math.min(requestedTo, latestBlock);
    return {
      blockFrom: Math.max(0, Math.max(lowerBound, latestBlock - delta)),
      blockTo: latestBlock,
    };
  }

  return {
    blockFrom: Math.max(0, latestBlock - delta),
    blockTo: latestBlock,
  };
}

export async function collectRawRoundSnapshot(
  chain: string,
  requestedRange: RawRoundRangeInput = {},
): Promise<RawRoundSnapshot> {
  const config = getChainConfig(chain);
  const pipelineSource = config.pipelineSource;
  const latestBlock = pipelineSource === 'rpc'
    ? await getLatestBlockNumber(chain)
    : await getLatestBlock(chain);
  const { blockFrom, blockTo } = resolveRoundRange(latestBlock, config.blocksPerScan, requestedRange);

  if (blockTo <= 0) {
    return {
      chain,
      roundId: makeRoundId(chain, blockFrom, blockTo),
      blockFrom,
      blockTo,
      transfers: [],
      traces: [],
    };
  }

  logger.info(
    `[${chain}] Raw data module: latest=${latestBlock}, requested from=${requestedRange.fromBlock ?? '-'} to=${requestedRange.toBlock ?? '-'} delta=${requestedRange.deltaBlocks ?? config.blocksPerScan}, planned range=(${blockFrom}, ${blockTo}]`,
  );
  logger.info(`[${chain}] Raw data module: collecting ${pipelineSource} transfers${pipelineSource === 'chainbase' ? ' + traces' : ''}`);
  const transfers: TransferRow[] = pipelineSource === 'rpc'
    ? await getTransferLogs(chain, blockFrom, blockTo)
    : await getTransfers(chain, blockFrom, blockTo);
  const traces: TraceRow[] = pipelineSource === 'rpc'
    ? []
    : await getValueTraces(chain, blockFrom, blockTo);
  const roundId = makeRoundId(chain, blockFrom, blockTo);

  storeRawRoundSnapshot({
    roundId,
    chain,
    blockFrom,
    blockTo,
    transfers,
    traces,
  });

  logger.info(`[${chain}] Raw data module: stored ${transfers.length} transfers, ${traces.length} traces (source=${pipelineSource})`);
  return {
    chain,
    roundId,
    blockFrom,
    blockTo,
    transfers,
    traces,
  };
}

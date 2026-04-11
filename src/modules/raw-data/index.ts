import { getChainConfig } from '../../config.js';
import { getLatestBlock, getTransfers, getValueTraces, TransferRow, TraceRow } from '../../chainbase/queries.js';
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

function makeRoundId(chain: string, blockFrom: number, blockTo: number): string {
  return `${chain.toLowerCase()}:${blockFrom}:${blockTo}`;
}

export async function collectRawRoundSnapshot(chain: string): Promise<RawRoundSnapshot> {
  const config = getChainConfig(chain);
  const latestBlock = await getLatestBlock(chain);
  const blockTo = latestBlock;
  const blockFrom = Math.max(0, latestBlock - config.blocksPerScan);

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

  logger.info(`[${chain}] Raw data module: collecting transfers + traces`);
  const transfers = await getTransfers(chain, blockFrom, blockTo);
  const traces = await getValueTraces(chain, blockFrom, blockTo);
  const roundId = makeRoundId(chain, blockFrom, blockTo);

  storeRawRoundSnapshot({
    roundId,
    chain,
    blockFrom,
    blockTo,
    transfers,
    traces,
  });

  logger.info(`[${chain}] Raw data module: stored ${transfers.length} transfers, ${traces.length} traces`);
  return {
    chain,
    roundId,
    blockFrom,
    blockTo,
    transfers,
    traces,
  };
}

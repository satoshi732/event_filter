import { getDb } from './core.js';
import { RawTraceInput, RawTransferInput } from './types.js';

export function getLastBlock(chain: string): number {
  const row = getDb()
    .prepare('SELECT last_block FROM scan_state WHERE chain = ?')
    .get(chain.toLowerCase()) as { last_block: number } | undefined;
  return row?.last_block ?? 0;
}

export function getLatestRawRoundBounds(chain: string): { blockFrom: number; blockTo: number } | null {
  const row = getDb().prepare(`
    SELECT block_from, block_to
    FROM raw_rounds
    WHERE chain = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(chain.toLowerCase()) as {
    block_from: number;
    block_to: number;
  } | undefined;

  if (!row) return null;
  return {
    blockFrom: row.block_from,
    blockTo: row.block_to,
  };
}

export function setLastBlock(chain: string, block: number): void {
  getDb().prepare(`
    INSERT INTO scan_state (chain, last_block, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(chain) DO UPDATE SET last_block = excluded.last_block, updated_at = datetime('now')
  `).run(chain.toLowerCase(), block);
}

export function saveRawRoundData(input: {
  roundId: string;
  chain: string;
  blockFrom: number;
  blockTo: number;
  transfers: RawTransferInput[];
  traces: RawTraceInput[];
}): void {
  const chain = input.chain.toLowerCase();
  const db = getDb();
  const upsertRound = db.prepare(`
    INSERT INTO raw_rounds (round_id, chain, block_from, block_to, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(round_id) DO UPDATE SET
      chain = excluded.chain,
      block_from = excluded.block_from,
      block_to = excluded.block_to,
      created_at = datetime('now')
  `);
  const deleteTransfers = db.prepare(`DELETE FROM raw_token_transfers WHERE round_id = ? AND chain = ?`);
  const deleteTraces = db.prepare(`DELETE FROM raw_value_traces WHERE round_id = ? AND chain = ?`);
  const upsertScanState = db.prepare(`
    INSERT INTO scan_state (chain, last_block, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(chain) DO UPDATE SET
      last_block = excluded.last_block,
      updated_at = datetime('now')
  `);
  const insertTransfer = db.prepare(`
    INSERT INTO raw_token_transfers (
      round_id, chain, transaction_hash, from_address, to_address, token_address, value, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertTrace = db.prepare(`
    INSERT INTO raw_value_traces (
      round_id, chain, transaction_hash, from_address, to_address, value, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const run = db.transaction(() => {
    upsertRound.run(input.roundId, chain, input.blockFrom, input.blockTo);
    upsertScanState.run(chain, input.blockTo);
    deleteTransfers.run(input.roundId, chain);
    deleteTraces.run(input.roundId, chain);
    for (const row of input.transfers) {
      if (!row.contract_address) continue;
      insertTransfer.run(
        input.roundId,
        chain,
        row.transaction_hash,
        row.from_address?.toLowerCase() ?? null,
        row.to_address?.toLowerCase() ?? null,
        row.contract_address.toLowerCase(),
        row.value ?? '0',
      );
    }
    for (const row of input.traces) {
      insertTrace.run(
        input.roundId,
        chain,
        row.transaction_hash,
        row.from_address?.toLowerCase() ?? null,
        row.to_address?.toLowerCase() ?? null,
        row.value ?? '0',
      );
    }
  });

  run();
}

import { saveRawRoundData } from '../../db.js';
import { TraceRow, TransferRow } from '../../chainbase/queries.js';

export function storeRawRoundSnapshot(input: {
  roundId: string;
  chain: string;
  blockFrom: number;
  blockTo: number;
  transfers: TransferRow[];
  traces: TraceRow[];
}): void {
  saveRawRoundData(input);
}

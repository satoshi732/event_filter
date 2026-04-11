import { upsertTokenContractBalanceBatch } from '../../db.js';

export function storeTokenContractBalanceRows(
  chain: string,
  rows: Array<{ tokenAddress: string; contractAddr: string; balance: string }>,
): void {
  upsertTokenContractBalanceBatch(chain, rows);
}

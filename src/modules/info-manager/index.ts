import { storeTokenContractBalanceRows } from './repository.js';

export function persistTokenContractBalances(
  chain: string,
  rows: Array<{ tokenAddress: string; contractAddr: string; balance: string | null }>,
): void {
  if (!rows.length) return;
  storeTokenContractBalanceRows(
    chain,
    rows.map((row) => ({
      tokenAddress: row.tokenAddress.toLowerCase(),
      contractAddr: row.contractAddr.toLowerCase(),
      balance: row.balance ?? '0',
    })),
  );
}

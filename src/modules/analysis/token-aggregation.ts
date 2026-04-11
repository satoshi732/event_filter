import { ContractInfo, TraceRow, TransferRow } from '../../chainbase/queries.js';
import { getNativeTokenRef } from '../../utils/rpc.js';
import { safeBigInt } from './index.js';

export interface AddrEntry {
  xfer_out: number;
  xfer_in: number;
  eth_out: bigint;
  eth_in: bigint;
  tx_hashes: Set<string>;
}

export interface CounterpartyAgg {
  address: string | null;
  label: string;
  is_contract: boolean;
  transfer_in_count: number;
  transfer_in_amount: bigint;
  transfer_out_count: number;
  transfer_out_amount: bigint;
  tx_hashes: Set<string>;
}

export interface TokenContractAgg {
  contract: string;
  transfer_in_count: number;
  transfer_in_amount: bigint;
  transfer_out_count: number;
  transfer_out_amount: bigint;
  tx_hashes: Set<string>;
  counterparties: Map<string, CounterpartyAgg>;
}

export interface TokenAgg {
  token: string;
  total_transfer_count: number;
  total_transfer_amount: bigint;
  contracts: Map<string, TokenContractAgg>;
}

function getAddrEntry(map: Map<string, AddrEntry>, addr: string): AddrEntry {
  const key = addr.toLowerCase();
  let entry = map.get(key);
  if (!entry) {
    entry = {
      xfer_out: 0,
      xfer_in: 0,
      eth_out: 0n,
      eth_in: 0n,
      tx_hashes: new Set(),
    };
    map.set(key, entry);
  }
  return entry;
}

function getTokenAgg(map: Map<string, TokenAgg>, token: string): TokenAgg {
  const key = token.toLowerCase();
  let entry = map.get(key);
  if (!entry) {
    entry = {
      token: key,
      total_transfer_count: 0,
      total_transfer_amount: 0n,
      contracts: new Map(),
    };
    map.set(key, entry);
  }
  return entry;
}

function getTokenContractAgg(tokenAgg: TokenAgg, contract: string): TokenContractAgg {
  const key = contract.toLowerCase();
  let entry = tokenAgg.contracts.get(key);
  if (!entry) {
    entry = {
      contract: key,
      transfer_in_count: 0,
      transfer_in_amount: 0n,
      transfer_out_count: 0,
      transfer_out_amount: 0n,
      tx_hashes: new Set(),
      counterparties: new Map(),
    };
    tokenAgg.contracts.set(key, entry);
  }
  return entry;
}

function getCounterpartyAgg(
  pairAgg: TokenContractAgg,
  counterparty: string,
  isContract: boolean,
): CounterpartyAgg {
  const normalized = counterparty.toLowerCase();
  const key = isContract ? normalized : '__eoa__';
  let entry = pairAgg.counterparties.get(key);
  if (!entry) {
    entry = {
      address: isContract ? normalized : null,
      label: isContract ? normalized : 'All EOAs',
      is_contract: isContract,
      transfer_in_count: 0,
      transfer_in_amount: 0n,
      transfer_out_count: 0,
      transfer_out_amount: 0n,
      tx_hashes: new Set(),
    };
    pairAgg.counterparties.set(key, entry);
  }
  return entry;
}

export function buildAddressActivityMap(
  transfers: TransferRow[],
  traces: TraceRow[],
): Map<string, AddrEntry> {
  const addrAgg = new Map<string, AddrEntry>();

  for (const transfer of transfers) {
    if (transfer.from_address) {
      const entry = getAddrEntry(addrAgg, transfer.from_address);
      entry.xfer_out += 1;
      entry.tx_hashes.add(transfer.transaction_hash);
    }
    if (transfer.to_address) {
      const entry = getAddrEntry(addrAgg, transfer.to_address);
      entry.xfer_in += 1;
      entry.tx_hashes.add(transfer.transaction_hash);
    }
  }

  for (const trace of traces) {
    const value = safeBigInt(trace.value);
    if (trace.from_address) {
      const entry = getAddrEntry(addrAgg, trace.from_address);
      entry.eth_out += value;
      entry.tx_hashes.add(trace.transaction_hash);
    }
    if (trace.to_address) {
      const entry = getAddrEntry(addrAgg, trace.to_address);
      entry.eth_in += value;
      entry.tx_hashes.add(trace.transaction_hash);
    }
  }

  return addrAgg;
}

export function buildTokenAggs(
  chain: string,
  transfers: TransferRow[],
  traces: TraceRow[],
  candidateContracts: Set<string>,
  contractInfos: Map<string, ContractInfo>,
): Map<string, TokenAgg> {
  const tokenAggs = new Map<string, TokenAgg>();
  const nativeToken = getNativeTokenRef(chain);

  for (const transfer of transfers) {
    const token = transfer.contract_address?.toLowerCase();
    if (!token) continue;

    const value = safeBigInt(transfer.value);
    let relevant = false;

    if (transfer.from_address) {
      const from = transfer.from_address.toLowerCase();
      if (candidateContracts.has(from)) {
        const tokenAgg = getTokenAgg(tokenAggs, token);
        const pairAgg = getTokenContractAgg(tokenAgg, from);
        pairAgg.transfer_out_count += 1;
        pairAgg.transfer_out_amount += value;
        pairAgg.tx_hashes.add(transfer.transaction_hash);
        if (transfer.to_address) {
          const counterparty = getCounterpartyAgg(
            pairAgg,
            transfer.to_address,
            Boolean(contractInfos.get(transfer.to_address.toLowerCase())?.bytecode),
          );
          counterparty.transfer_out_count += 1;
          counterparty.transfer_out_amount += value;
          counterparty.tx_hashes.add(transfer.transaction_hash);
        }
        relevant = true;
      }
    }

    if (transfer.to_address) {
      const to = transfer.to_address.toLowerCase();
      if (candidateContracts.has(to)) {
        const tokenAgg = getTokenAgg(tokenAggs, token);
        const pairAgg = getTokenContractAgg(tokenAgg, to);
        pairAgg.transfer_in_count += 1;
        pairAgg.transfer_in_amount += value;
        pairAgg.tx_hashes.add(transfer.transaction_hash);
        if (transfer.from_address) {
          const counterparty = getCounterpartyAgg(
            pairAgg,
            transfer.from_address,
            Boolean(contractInfos.get(transfer.from_address.toLowerCase())?.bytecode),
          );
          counterparty.transfer_in_count += 1;
          counterparty.transfer_in_amount += value;
          counterparty.tx_hashes.add(transfer.transaction_hash);
        }
        relevant = true;
      }
    }

    if (relevant) {
      const tokenAgg = getTokenAgg(tokenAggs, token);
      tokenAgg.total_transfer_count += 1;
      tokenAgg.total_transfer_amount += value;
    }
  }

  for (const trace of traces) {
    const value = safeBigInt(trace.value);
    let relevant = false;

    if (trace.from_address) {
      const from = trace.from_address.toLowerCase();
      if (candidateContracts.has(from)) {
        const tokenAgg = getTokenAgg(tokenAggs, nativeToken);
        const pairAgg = getTokenContractAgg(tokenAgg, from);
        pairAgg.transfer_out_count += 1;
        pairAgg.transfer_out_amount += value;
        pairAgg.tx_hashes.add(trace.transaction_hash);
        if (trace.to_address) {
          const counterparty = getCounterpartyAgg(
            pairAgg,
            trace.to_address,
            Boolean(contractInfos.get(trace.to_address.toLowerCase())?.bytecode),
          );
          counterparty.transfer_out_count += 1;
          counterparty.transfer_out_amount += value;
          counterparty.tx_hashes.add(trace.transaction_hash);
        }
        relevant = true;
      }
    }

    if (trace.to_address) {
      const to = trace.to_address.toLowerCase();
      if (candidateContracts.has(to)) {
        const tokenAgg = getTokenAgg(tokenAggs, nativeToken);
        const pairAgg = getTokenContractAgg(tokenAgg, to);
        pairAgg.transfer_in_count += 1;
        pairAgg.transfer_in_amount += value;
        pairAgg.tx_hashes.add(trace.transaction_hash);
        if (trace.from_address) {
          const counterparty = getCounterpartyAgg(
            pairAgg,
            trace.from_address,
            Boolean(contractInfos.get(trace.from_address.toLowerCase())?.bytecode),
          );
          counterparty.transfer_in_count += 1;
          counterparty.transfer_in_amount += value;
          counterparty.tx_hashes.add(trace.transaction_hash);
        }
        relevant = true;
      }
    }

    if (relevant) {
      const tokenAgg = getTokenAgg(tokenAggs, nativeToken);
      tokenAgg.total_transfer_count += 1;
      tokenAgg.total_transfer_amount += value;
    }
  }

  return tokenAggs;
}

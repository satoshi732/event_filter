/**
 * Proxy / EIP-7702 detection based on DELEGATECALL traces.
 *
 * No RPC calls needed — purely Chainbase SQL trace data.
 *
 * - delegateMap from_address IN contracts table → proxy (from=proxy, to=impl)
 * - delegateMap from_address NOT IN contracts table → EIP-7702 (from=EOA, to=delegate)
 */

export interface ProxyResult {
  type: 'proxy' | 'eip7702';
  implementation: string; // 0x-prefixed lowercase
}

/**
 * Classify delegatecall relationships using contract info.
 *
 * @param delegateMap  Map<from_address → to_address> from trace_calls DELEGATECALL
 * @param contractMap  Map<address → ContractInfo> from contracts table
 * @returns Map<from_address → ProxyResult>
 */
export function classifyDelegations(
  delegateMap: Map<string, string>,
  contractMap: Map<string, { bytecode: string }>,
): Map<string, ProxyResult> {
  const result = new Map<string, ProxyResult>();

  for (const [from, to] of delegateMap) {
    const hasContract = contractMap.has(from) && contractMap.get(from)!.bytecode.length > 0;

    if (hasContract) {
      result.set(from, { type: 'proxy', implementation: to });
    } else {
      result.set(from, { type: 'eip7702', implementation: to });
    }
  }

  return result;
}

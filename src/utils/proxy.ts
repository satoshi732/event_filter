import { callContractData, getStorageAt } from './rpc.js';

const OP_CALLDATASIZE = '36';
const OP_CALLDATACOPY = '37';
const OP_DELEGATECALL = 'f4';
const OP_RETURNDATASIZE = '3d';
const OP_RETURNDATACOPY = '3e';
const OP_RETURN = 'f3';
const OP_REVERT = 'fd';
const OP_PUSH4 = '63';
const OP_EQ = '14';
const OP_JUMPI = '57';

const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1167_ALT_PREFIX = '3d602d80600a3d3981f3363d3d373d3d3d363d73';
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const IMPLEMENTATION_SELECTOR = '0x5c60da1b';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export interface ProxyResult {
  type: 'proxy' | 'eip7702';
  implementation: string; // 0x-prefixed lowercase
  detectedBy?: string;
}

export type ProxyClassification =
  | { type: 'minimal-proxy'; implementation: string }
  | { type: 'single-impl-forwarding' }
  | { type: 'non-proxy' };

function normalizeBytecode(bytecode: string | null | undefined): string {
  const value = String(bytecode ?? '').trim().toLowerCase();
  if (!value || value === '0x') return '';
  return value.startsWith('0x') ? value.slice(2) : value;
}

function normalizeAddress(value: string | null | undefined): string | null {
  const address = String(value ?? '').trim().toLowerCase();
  if (address === ZERO_ADDR || !/^0x[a-f0-9]{40}$/.test(address)) return null;
  return address;
}

export function extractEip7702DelegateAddress(bytecode: string): string | null {
  const hex = normalizeBytecode(bytecode);
  if (hex.length !== 46 || !hex.startsWith('ef0100')) return null;
  const addressHex = hex.slice(6, 46);
  return /^[0-9a-f]{40}$/.test(addressHex) ? `0x${addressHex}` : null;
}

export function extractMinimalProxyTarget(bytecode: string): string | null {
  const hex = normalizeBytecode(bytecode);
  if (!hex) return null;

  for (const prefix of [EIP1167_PREFIX, EIP1167_ALT_PREFIX]) {
    const idx = hex.indexOf(prefix);
    if (idx === -1) continue;
    const addrStart = idx + prefix.length;
    const addr = hex.slice(addrStart, addrStart + 40);
    if (/^[0-9a-f]{40}$/.test(addr)) return `0x${addr}`;
  }

  return null;
}

function extractOpcodeSequence(hex: string): string[] {
  const opcodes: string[] = [];
  let i = 0;
  while (i + 2 <= hex.length) {
    const op = hex.slice(i, i + 2);
    opcodes.push(op);
    i += 2;

    const opNum = Number.parseInt(op, 16);
    if (opNum >= 0x60 && opNum <= 0x7f) {
      i += (opNum - 0x5f) * 2;
    }
  }
  return opcodes;
}

function hasForwardingSkeleton(opcodes: string[]): boolean {
  let seenCalldataSize = false;
  let seenCalldataCopy = false;
  for (const op of opcodes) {
    if (op === OP_CALLDATASIZE) seenCalldataSize = true;
    if (op === OP_CALLDATACOPY && seenCalldataSize) seenCalldataCopy = true;
    if (op === OP_DELEGATECALL && seenCalldataCopy) return true;
  }
  return false;
}

function hasReturnDataBubble(opcodes: string[]): boolean {
  let seenDelegatecall = false;
  let seenReturnDataSize = false;
  let seenReturnDataCopy = false;
  for (const op of opcodes) {
    if (op === OP_DELEGATECALL) seenDelegatecall = true;
    if (op === OP_RETURNDATASIZE && seenDelegatecall) seenReturnDataSize = true;
    if (op === OP_RETURNDATACOPY && seenReturnDataSize) seenReturnDataCopy = true;
    if ((op === OP_RETURN || op === OP_REVERT) && seenReturnDataCopy) return true;
  }
  return false;
}

function hasSelectorDependentTargeting(opcodes: string[]): boolean {
  let delegatecallCount = 0;
  for (const op of opcodes) {
    if (op === OP_DELEGATECALL) delegatecallCount += 1;
  }
  if (delegatecallCount >= 3) return true;

  let selectorBranches = 0;
  for (let i = 0; i < opcodes.length - 4; i += 1) {
    if (opcodes[i] !== OP_PUSH4) continue;
    for (let j = i + 1; j < Math.min(i + 6, opcodes.length - 1); j += 1) {
      if (opcodes[j] !== OP_EQ) continue;
      for (let k = j + 1; k < Math.min(j + 4, opcodes.length); k += 1) {
        if (opcodes[k] === OP_JUMPI) {
          selectorBranches += 1;
          break;
        }
      }
      break;
    }
  }

  return (selectorBranches >= 3 && delegatecallCount >= 2) || selectorBranches >= 6;
}

export function classifyProxyBytecode(bytecode: string): ProxyClassification {
  const hex = normalizeBytecode(bytecode);
  if (!hex) return { type: 'non-proxy' };

  const minimalTarget = extractMinimalProxyTarget(bytecode);
  if (minimalTarget) return { type: 'minimal-proxy', implementation: minimalTarget };

  const opcodes = extractOpcodeSequence(hex);
  if (!opcodes.includes(OP_DELEGATECALL)) return { type: 'non-proxy' };
  if (!hasForwardingSkeleton(opcodes)) return { type: 'non-proxy' };
  if (!hasReturnDataBubble(opcodes)) return { type: 'non-proxy' };
  if (hasSelectorDependentTargeting(opcodes)) return { type: 'non-proxy' };

  return { type: 'single-impl-forwarding' };
}

function hasDelegatecall(bytecode: string): boolean {
  return normalizeBytecode(bytecode).includes(OP_DELEGATECALL);
}

function slotToAddress(slot: string): string | null {
  const cleaned = String(slot ?? '').trim().toLowerCase().replace(/^0x/, '').padStart(64, '0');
  if (!/^[a-f0-9]{64}$/.test(cleaned)) return null;
  return normalizeAddress(`0x${cleaned.slice(24)}`);
}

function callResultToAddress(data: string): string | null {
  const hex = String(data ?? '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^[a-f0-9]+$/.test(hex) || hex.length < 64) return null;
  return normalizeAddress(`0x${hex.padStart(64, '0').slice(-40)}`);
}

async function resolveBeaconImplementation(chain: string, beacon: string): Promise<string | null> {
  try {
    return callResultToAddress(await callContractData(chain, beacon, IMPLEMENTATION_SELECTOR));
  } catch {
    return null;
  }
}

export async function resolveProxyByBytecode(
  chain: string,
  address: string,
  bytecode: string,
): Promise<ProxyResult | null> {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) return null;

  const eip7702Delegate = extractEip7702DelegateAddress(bytecode);
  if (eip7702Delegate) {
    return {
      type: 'eip7702',
      implementation: eip7702Delegate,
      detectedBy: 'eip7702-bytecode',
    };
  }

  const classification = classifyProxyBytecode(bytecode);
  if (classification.type === 'minimal-proxy') {
    return {
      type: 'proxy',
      implementation: classification.implementation,
      detectedBy: 'minimal-proxy-bytecode',
    };
  }

  if (classification.type !== 'single-impl-forwarding' && !hasDelegatecall(bytecode)) {
    return null;
  }

  try {
    const implAddr = slotToAddress(await getStorageAt(chain, normalizedAddress, EIP1967_IMPL_SLOT));
    if (implAddr) {
      return {
        type: 'proxy',
        implementation: implAddr,
        detectedBy: 'eip1967-slot',
      };
    }

    const beaconAddr = slotToAddress(await getStorageAt(chain, normalizedAddress, EIP1967_BEACON_SLOT));
    if (beaconAddr) {
      const beaconImpl = await resolveBeaconImplementation(chain, beaconAddr);
      if (beaconImpl) {
        return {
          type: 'proxy',
          implementation: beaconImpl,
          detectedBy: 'eip1967-beacon',
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Classify delegatecall relationships using contract info.
 *
 * @param delegateMap  Map<from_address -> to_address> from trace_calls DELEGATECALL
 * @param contractMap  Map<address -> ContractInfo> from contracts table
 * @returns Map<from_address -> ProxyResult>
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

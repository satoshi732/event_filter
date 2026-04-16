import { selectorHash } from '../../utils/selector-pattern.js';
import { getContractBytecode } from '../../utils/rpc.js';
import { logger } from '../../utils/logger.js';
import { extractSelectors } from '../../analyzer/bytecode.js';

export interface FetchedContractPattern {
  contractAddr: string;
  contractName: string;
  sourceCode: string;
  bytecode: string;
  selectors: string[];
  selectorHash: string;
  codeSize: number;
}

function normalizeAddress(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeSelectors(selectors: string[]): string[] {
  return [...new Set(selectors.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

export async function fetchVerifiedContractPattern(chain: string, contractAddr: string): Promise<FetchedContractPattern | null> {
  const normalizedChain = String(chain || '').trim().toLowerCase();
  const normalizedAddress = normalizeAddress(contractAddr);
  if (!normalizedChain || !normalizedAddress) return null;

  let bytecode = '';
  try {
    bytecode = await getContractBytecode(normalizedChain, normalizedAddress);
  } catch (error) {
    logger.warn(`[${normalizedChain}] Contract manager: bytecode fetch failed for ${normalizedAddress}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const normalizedBytecode = String(bytecode || '').trim().toLowerCase();
  if (!normalizedBytecode || normalizedBytecode === '0x') {
    logger.info(`[${normalizedChain}] Contract manager: no runtime bytecode returned for ${normalizedAddress}`);
    return null;
  }

  const selectors = normalizeSelectors(extractSelectors(normalizedBytecode) ?? []);
  if (!selectors.length) {
    logger.info(`[${normalizedChain}] Contract manager: runtime bytecode produced no dispatch selectors for ${normalizedAddress}`);
    return null;
  }

  const codeSize = normalizedBytecode.startsWith('0x')
    ? Math.floor((normalizedBytecode.length - 2) / 2)
    : Math.floor(normalizedBytecode.length / 2);

  return {
    contractAddr: normalizedAddress,
    contractName: '',
    sourceCode: '',
    bytecode: normalizedBytecode,
    selectors,
    selectorHash: selectorHash(selectors),
    codeSize,
  };
}

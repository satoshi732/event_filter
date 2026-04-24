import { codeSizeDiverges, jaccard } from '../../utils/selector-pattern.js';
import { SeenSelectorEntry, storeSelectorsTempRows } from './repository.js';

export interface SelectorTempRow {
  contractAddr: string;
  selectorHash: string;
  selectors: string[];
  label?: string;
  bytecodeSize?: number;
  status?: string;
  lastError?: string | null;
}

export function buildSelectorsTempRows(
  _chain: string,
  rows: SelectorTempRow[],
): SelectorTempRow[] {
  return rows
    .map((row) => ({
      contractAddr: row.contractAddr.toLowerCase(),
      selectorHash: row.selectorHash,
      selectors: [...new Set(row.selectors.map((selector) => selector.toLowerCase()))],
      label: row.label ?? '',
      bytecodeSize: row.bytecodeSize ?? 0,
      status: row.status ?? 'pending',
      lastError: row.lastError ?? null,
    }))
    .filter((row) => row.contractAddr && row.selectorHash && row.selectors.length > 0);
}

export function persistSelectorsTempRows(chain: string, rows: SelectorTempRow[]): void {
  if (!rows.length) return;
  storeSelectorsTempRows(chain, rows);
}

export { listSeenSelectorEntries } from './repository.js';

export function matchSeenLabelBySimilarity(
  selectors: string[],
  codeSize: number,
  seenEntries: SeenSelectorEntry[],
): string | undefined {
  return matchSeenEntryBySimilarity(selectors, codeSize, seenEntries)?.label;
}

export function matchSeenEntryBySimilarity(
  selectors: string[],
  codeSize: number,
  seenEntries: SeenSelectorEntry[],
): SeenSelectorEntry | undefined {
  if (!selectors.length) return undefined;
  const selectorSet = new Set(selectors);
  for (const entry of seenEntries) {
    if (jaccard(selectorSet, entry.selectors) >= 0.9
        && !codeSizeDiverges(codeSize, entry.bytecodeSize)) {
      return entry;
    }
  }
  return undefined;
}

export * from './sync.js';

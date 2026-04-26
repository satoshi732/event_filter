import {
  SeenSelectorEntry,
  SelectorTempReviewTarget,
  addSeenSelectors,
  findSelectorTempReviewTarget,
  getPatternSyncState,
  getSeenContractQueueCounts,
  getSeenContractsForPush,
  getSeenSelectorEntries,
  markSeenContractPushResult,
  updatePatternSyncState,
  upsertSeenContractReview,
  upsertSelectorsTempBatch,
} from '../../db.js';

export type { SeenSelectorEntry, SelectorTempReviewTarget };

export function storeSelectorsTempRows(
  chain: string,
  rows: Array<{
    contractAddr: string;
    selectorHash: string;
    selectors: string[];
    label?: string;
    bytecodeSize?: number;
    preparedByUsername?: string;
    status?: string;
    lastError?: string | null;
  }>,
): void {
  upsertSelectorsTempBatch(chain, rows);
}

export function listSeenSelectorEntries(): SeenSelectorEntry[] {
  return getSeenSelectorEntries();
}

export function findReviewTarget(
  chain: string,
  address: string,
  targetKind = 'auto',
): SelectorTempReviewTarget | null {
  return findSelectorTempReviewTarget(chain, address, targetKind);
}

export function saveSeenSelectorPattern(
  selectors: string[],
  label: string,
  bytecodeSize = 0,
  createdByUsername = '',
): string {
  return addSeenSelectors(selectors, label, bytecodeSize, null, createdByUsername);
}

export {
  getPatternSyncState,
  getSeenContractQueueCounts,
  getSeenContractsForPush,
  markSeenContractPushResult,
  updatePatternSyncState,
  upsertSeenContractReview,
};

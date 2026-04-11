import {
  getPatternSyncStatus,
  pullPatterns,
  pushPatterns,
  verifyPatterns,
} from '../modules/selectors-manager/index.js';
import { flag } from './shared.js';

export async function runSyncAdminCommand(args: string[]): Promise<number | null> {
  if (flag(args, '--sync-status')) {
    const status = await getPatternSyncStatus();
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }

  if (flag(args, '--sync-pull')) {
    const result = await pullPatterns();
    console.log(`Pulled ${result.pulled} patterns${result.lastPullAt ? ` (last ${result.lastPullAt})` : ''}`);
    return 0;
  }

  if (flag(args, '--sync-push')) {
    const result = await pushPatterns();
    console.log(`Pushed ${result.pushed} queued patterns, failed ${result.failed}`);
    return 0;
  }

  if (flag(args, '--sync-verify')) {
    const result = await verifyPatterns();
    console.log(`Verified ${result.checked} remote patterns`);
    if (result.mismatches.length) {
      console.log(JSON.stringify(result.mismatches, null, 2));
      return 1;
    }
    return 0;
  }

  return null;
}

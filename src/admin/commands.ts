import { runPatternAdminCommand } from './patterns.js';
import { runSyncAdminCommand } from './sync.js';
import { runWhitelistAdminCommand } from './whitelist.js';

export async function runAdminCommand(args: string[]): Promise<number | null> {
  for (const runner of [
    runWhitelistAdminCommand,
    runPatternAdminCommand,
    runSyncAdminCommand,
  ]) {
    const exitCode = await runner(args);
    if (exitCode !== null) return exitCode;
  }
  return null;
}

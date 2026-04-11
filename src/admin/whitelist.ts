import {
  addWhitelistPattern,
  listWhitelistPatterns,
  removeWhitelistPattern,
} from '../db.js';
import { after, flag } from './shared.js';

export async function runWhitelistAdminCommand(args: string[]): Promise<number | null> {
  if (flag(args, '--list-patterns')) {
    console.log('\n-- Whitelist patterns --');
    listWhitelistPatterns();
    return 0;
  }

  if (flag(args, '--add-whitelist-pat')) {
    const [name, hex, type, scoreStr, ...rest] = after(args, '--add-whitelist-pat');
    if (!name || !hex || !type || !scoreStr) {
      console.error('Usage: --add-whitelist-pat <name> <hex> <selector|opcode|call> <score> [description]');
      return 1;
    }
    addWhitelistPattern(name, hex, type, parseInt(scoreStr, 10), rest.join(' '));
    return 0;
  }

  if (flag(args, '--rm-whitelist-pat')) {
    const [name] = after(args, '--rm-whitelist-pat');
    if (!name) {
      console.error('Usage: --rm-whitelist-pat <name>');
      return 1;
    }
    removeWhitelistPattern(name);
    return 0;
  }

  return null;
}

import { readFileSync } from 'fs';
import {
  queueSeenContractReviewTarget,
  queueSeenPattern,
} from '../modules/selectors-manager/index.js';
import { after, flag } from './shared.js';

export async function runPatternAdminCommand(args: string[]): Promise<number | null> {
  if (flag(args, '--mark-seen-pattern')) {
    const rest = after(args, '--mark-seen-pattern');
    if (rest.length < 2) {
      console.error('Usage: --mark-seen-pattern <selectors> <description>');
      console.error('  e.g. --mark-seen-pattern "0902f1ac,022c0d9f,6a627842" "UniswapV2Pair"');
      return 1;
    }
    const sels = rest[0].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const desc = rest.slice(1).join(' ');
    if (!sels.length) {
      console.error('No selectors provided');
      return 1;
    }
    const hash = queueSeenPattern(desc, sels, 0);
    console.log(`Seen pattern queued: "${desc}" (${sels.length} selectors) [${hash.slice(0, 12)}]`);
    return 0;
  }

  if (flag(args, '--import-seen-patterns')) {
    const [filePath] = after(args, '--import-seen-patterns');
    if (!filePath) {
      console.error('Usage: --import-seen-patterns <json-file>');
      console.error('  JSON format: [{"description":"...","patterns":["0902f1ac","022c0d9f",...]}, ...]');
      return 1;
    }

    let entries: { label?: string; description?: string; selectors?: string[]; patterns?: string[]; bytecode_size?: number }[];
    try {
      entries = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (e: any) {
      console.error(`Failed to parse JSON: ${e.message}`);
      return 1;
    }
    if (!Array.isArray(entries)) {
      console.error('JSON must be an array');
      return 1;
    }

    let count = 0;
    for (const entry of entries) {
      const label = (entry.label ?? entry.description)?.trim();
      const sels = (entry.selectors ?? entry.patterns)
        ?.map((s: string) => s.replace(/^0x/i, '').trim().toLowerCase()).filter(Boolean);
      if (!label || !sels?.length) {
        console.warn('Skipping entry: missing label or selectors');
        continue;
      }
      const hash = queueSeenPattern(label, sels, entry.bytecode_size ?? 0);
      console.log(`  + "${label}" (${sels.length} sels) [${hash.slice(0, 12)}]`);
      count++;
    }
    console.log(`Imported ${count} seen patterns from ${filePath}`);
    return 0;
  }

  if (flag(args, '--queue-seen-contract')) {
    const [chain, address, ...labelRest] = after(args, '--queue-seen-contract');
    const label = labelRest.join(' ').trim();
    if (!chain || !address || !label) {
      console.error('Usage: --queue-seen-contract <chain> <address> <label>');
      return 1;
    }
    const hash = queueSeenContractReviewTarget(chain, address, label);
    console.log(`Queued seen contract: ${address} -> "${label}" [${hash.slice(0, 12)}]`);
    return 0;
  }

  return null;
}

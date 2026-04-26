#!/usr/bin/env node
/**
 * Solana Mev Labs — CLI entry point
 *
 * Web UI mode (default):
 *   node dist/index.js [--chain <name>]
 *   node dist/index.js --once          # single run then exit
 *
 * Management commands (no monitoring started):
 *   node dist/index.js --list-patterns
 *   node dist/index.js --sync-status
 *   node dist/index.js --sync-pull
 *   node dist/index.js --sync-push
 *   node dist/index.js --sync-verify
 *
 *   node dist/index.js --add-whitelist-pat     <name> <hex> <selector|opcode|call> [description]
 *   node dist/index.js --rm-whitelist-pat      <name>
 *   node dist/index.js --queue-seen-contract   <chain> <address> <label>
 *
 *   # Mark contract as seen (+ selector similarity filter)
 *   node dist/index.js --mark-seen-pattern     <selectors> <label>
 */

import { getAvailableChains, getMonitoredChains, getChainConfig } from './config.js';
import { PipelineRunResult, runPipeline } from './pipeline.js';
import { logger } from './utils/logger.js';
import { startWebServer } from './web/server.js';
import { maybeAutoPullPatterns } from './modules/selectors-manager/index.js';
import { runAdminCommand } from './admin/commands.js';

// ── Argument helpers ──────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const flag  = (f: string) => args.includes(f);
const after = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args.slice(i + 1) : []; };

const adminExitCode = await runAdminCommand(args);
if (adminExitCode !== null) {
  process.exit(adminExitCode);
}

// ── Determine chains to monitor ───────────────────────────────────────────────
let chains: string[];
if (flag('--chain')) {
  const chainArgs = after('--chain')[0];
  if (!chainArgs) { console.error('--chain requires chain name(s), e.g. --chain ethereum,polygon'); process.exit(1); }
  chains = chainArgs.split(',').map(c => c.trim().toLowerCase()).filter(Boolean);
  for (const c of chains) {
    try { getChainConfig(c); } catch (e) { console.error((e as Error).message); process.exit(1); }
  }
} else {
  chains = flag('--once') ? getMonitoredChains() : getAvailableChains();
}

if (!chains.length) {
  console.error('No valid chains configured. Use --chain or update monitored chains in the settings DB');
  process.exit(1);
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function runAllChains(): Promise<void> {
  for (const chain of chains) {
    try {
      await runPipeline(chain);
    } catch (err) {
      logger.error(`[${chain}] Pipeline error`, err);
      const failedRun: PipelineRunResult = {
        chain,
        generated_at: new Date().toISOString(),
        block_from: 0,
        block_to: 0,
        token_count: 0,
        tokens: [],
      };
    }
  }
}

if (flag('--once')) {
  logger.info('Single-run mode');
  maybeAutoPullPatterns()
    .then(runAllChains)
    .then(() => process.exit(0))
    .catch(e => { logger.error('Fatal', e); process.exit(1); });
} else {
  const host = '0.0.0.0';
  const port = 8000;
  logger.info(`Starting web UI for chains: ${chains.join(', ')}`);
  startWebServer(chains, host, port)
    .then(() => {
      maybeAutoPullPatterns().catch((e) => {
        logger.warn(`[pattern-sync] Background auto-pull failed: ${(e as Error).message || String(e)}`);
      });
    })
    .catch(e => { logger.error('Fatal', e); process.exit(1); });
}

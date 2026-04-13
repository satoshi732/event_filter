import { getAppSetting, setManyAppSettings } from '../../db.js';

export type AutoAnalysisPhase = 'idle' | 'screening' | 'auditing' | 'round' | 'draining';

export interface PersistedAutoAnalysisState {
  enabled: boolean;
  stopping: boolean;
  chain: string | null;
  phase: AutoAnalysisPhase;
  cycle: number;
  lastAction: string;
}

function normalizePhase(value: unknown): AutoAnalysisPhase {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'screening' || normalized === 'auditing' || normalized === 'round' || normalized === 'draining') {
    return normalized;
  }
  return 'idle';
}

function readBoolean(key: string, fallback: boolean): boolean {
  const value = String(getAppSetting(key) || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

export function loadPersistedAutoAnalysisState(): PersistedAutoAnalysisState {
  return {
    enabled: readBoolean('auto_analysis.enabled', false),
    stopping: readBoolean('auto_analysis.stopping', false),
    chain: String(getAppSetting('auto_analysis.chain') || '').trim().toLowerCase() || null,
    phase: normalizePhase(getAppSetting('auto_analysis.phase')),
    cycle: Math.max(0, Number(getAppSetting('auto_analysis.cycle') || 0) || 0),
    lastAction: String(getAppSetting('auto_analysis.last_action') || '').trim() || 'Auto analysis is idle',
  };
}

export function persistAutoAnalysisState(input: PersistedAutoAnalysisState): void {
  setManyAppSettings([
    { key: 'auto_analysis.enabled', value: input.enabled ? '1' : '0' },
    { key: 'auto_analysis.stopping', value: input.stopping ? '1' : '0' },
    { key: 'auto_analysis.chain', value: input.chain ?? '' },
    { key: 'auto_analysis.phase', value: input.phase },
    { key: 'auto_analysis.cycle', value: String(Math.max(0, Number(input.cycle) || 0)) },
    { key: 'auto_analysis.last_action', value: String(input.lastAction || '').trim() },
  ]);
}

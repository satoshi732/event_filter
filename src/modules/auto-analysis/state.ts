export type AutoAnalysisPhase = 'idle' | 'screening' | 'auditing' | 'round' | 'draining' | 'resting';

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
  if (normalized === 'screening' || normalized === 'auditing' || normalized === 'round' || normalized === 'draining' || normalized === 'resting') {
    return normalized;
  }
  return 'idle';
}

export function loadPersistedAutoAnalysisState(): PersistedAutoAnalysisState {
  return {
    enabled: false,
    stopping: false,
    chain: null,
    phase: 'idle',
    cycle: 0,
    lastAction: 'Auto analysis is idle',
  };
}

export function persistAutoAnalysisState(_input: PersistedAutoAnalysisState): void {
  // Auto-analysis state is intentionally in-memory only.
}

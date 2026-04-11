import { claudeProviderModule } from './claude.js';
import { codexProviderModule } from './codex.js';
import type { AiAuditProviderModule } from './types.js';

const PROVIDERS = new Map<string, AiAuditProviderModule>([
  [claudeProviderModule.id, claudeProviderModule],
  [codexProviderModule.id, codexProviderModule],
]);

export function getAiAuditProviderModule(provider: string): AiAuditProviderModule | null {
  return PROVIDERS.get(String(provider || '').trim().toLowerCase()) ?? null;
}

export type { AiAuditProviderModule, ProviderPromptContext, ProviderAuditMode } from './types.js';

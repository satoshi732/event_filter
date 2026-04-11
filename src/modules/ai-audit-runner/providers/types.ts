export type ProviderAuditMode = 'single' | 'proxy';

export interface ProviderPromptContext {
  mode: ProviderAuditMode;
  chain: string;
  auditAddress: string;
  verified: boolean;
  sourceCodePath: string;
}

export interface AiAuditProviderModule {
  id: string;
  buildPrompt(context: ProviderPromptContext): string;
}

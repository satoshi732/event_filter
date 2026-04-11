import type { AiAuditProviderModule, ProviderPromptContext } from './types.js';

function buildCodexPrompt(context: ProviderPromptContext): string {
  if (context.mode === 'single') {
    if (context.verified) {
      return `$evm-debugger-codex ${context.auditAddress} ${context.chain}`;
    }
    return `$evm-debugger-unverified-codex ${context.auditAddress} ${context.chain} decompiled-src-path: [${context.sourceCodePath}]`;
  }

  if (context.verified) {
    return `$evm-debugger-codex ${context.auditAddress} ${context.chain}`;
  }

  return `$evm-debugger-unverified-codex ${context.auditAddress} ${context.chain} impl_src:[${context.sourceCodePath}]`;
}

export const codexProviderModule: AiAuditProviderModule = {
  id: 'codex',
  buildPrompt: buildCodexPrompt,
};

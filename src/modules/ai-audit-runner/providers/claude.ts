import type { AiAuditProviderModule, ProviderPromptContext } from './types.js';

function buildClaudePrompt(context: ProviderPromptContext): string {
  if (context.mode === 'single') {
    if (context.verified) {
      return `/evm-debugger ${context.auditAddress} ${context.chain}`;
    }
    return `/evm-debugger-unverified ${context.auditAddress} ${context.chain} decompiled-src-path: [${context.sourceCodePath}]`;
  }

  if (context.verified) {
    return `/evm-debugger ${context.auditAddress} ${context.chain}`;
  }

  return `/evm-debugger-unverified ${context.auditAddress} ${context.chain} impl_src:[${context.sourceCodePath}]`;
}

export const claudeProviderModule: AiAuditProviderModule = {
  id: 'claude',
  buildPrompt: buildClaudePrompt,
};

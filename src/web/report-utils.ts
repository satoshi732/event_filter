export function pickDisplayableReportText(candidate: unknown): string {
  if (typeof candidate === 'string') {
    return candidate.trim();
  }
  if (candidate && typeof candidate === 'object') {
    try {
      return JSON.stringify(candidate, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

export function extractDisplayReportText(reportPath: string, reportText: string): string {
  const raw = String(reportText || '');
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const normalizedPath = String(reportPath || '').trim().toLowerCase();
  if (normalizedPath.endsWith('.md')) {
    const resultSection = raw.match(/\n## Result\s*\n\n([\s\S]*)$/i);
    return String(resultSection?.[1] || raw).trim();
  }

  if (normalizedPath.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, any>;
      const candidates = [
        parsed?.analysis?.analysis?.result,
        parsed?.analysis?.result,
        parsed?.result,
        parsed?.analysis?.analysis?.message,
        parsed?.analysis?.message,
      ];
      for (const candidate of candidates) {
        const selected = pickDisplayableReportText(candidate);
        if (selected) return selected;
      }
    } catch {
      return raw.trim();
    }
  }

  return raw.trim();
}

export function renderReportHtml(
  title: string,
  label: string,
  value: string,
  chain: string,
  reportPath: string,
  reportText: string,
  escapeHtml: (input: string) => string,
) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: "Space Grotesk", sans-serif; margin: 0; background: linear-gradient(180deg, #09141d 0%, #071019 100%); color: #e8f4ff; }
      main { max-width: 1100px; margin: 0 auto; padding: 24px; }
      .meta { margin-bottom: 16px; padding: 16px; border: 1px solid rgba(112, 180, 255, 0.14); border-radius: 12px; background: linear-gradient(180deg, rgba(15, 29, 44, 0.92) 0%, rgba(9, 18, 29, 0.98) 100%); }
      pre { white-space: pre-wrap; word-break: break-word; padding: 20px; border-radius: 12px; border: 1px solid rgba(112, 180, 255, 0.14); background: linear-gradient(180deg, rgba(12, 24, 38, 0.97) 0%, rgba(8, 16, 28, 0.985) 100%); overflow: auto; color: #d7e9fb; }
      code { font-family: "IBM Plex Mono", monospace; font-size: 13px; }
      strong { color: #f2f7ff; }
    </style>
  </head>
  <body>
    <main>
      <section class="meta">
        <strong>${escapeHtml(label)}</strong> ${escapeHtml(value)}<br>
        <strong>Chain</strong> ${escapeHtml(chain)}<br>
        <strong>Report Path</strong> ${escapeHtml(reportPath)}
      </section>
      <pre><code>${escapeHtml(reportText)}</code></pre>
    </main>
  </body>
</html>`;
}

import type { ShikiTransformer, ThemedToken } from '@shikijs/types';

// Actio-only macro keywords. Source of truth: the keyword table in
// docs/content/docs/syntax.mdx (plus call-templates/extends/if-changed, which
// are real macros documented in their detailed sections). Keep this in sync
// with that table — grouped by scope to make drift obvious.
const ACTIO_KEYWORDS = new Set([
  // workflow
  'params',
  'fragments',
  'job-defaults',
  'executors',
  'call-templates',
  'injection-hoist',
  'finally',
  // job
  'executor',
  'dynamic-matrix',
  'extends',
  // job / step
  'static-if',
  'fallback',
  'ensure',
  'on-success',
  'on-failure',
  'on-abort',
  'if-changed',
  // step
  'inject',
  'for-each',
  'retry',
  'share',
  'unsafe',
  'trust',
  'force',
]);

// Matches the first mapping key on a line, with an optional `- ` list marker.
// The optional `(...)` tail covers the `static-if(<expr>)` keyed-merge form;
// only the keyword name (group 2) is highlighted, not the expression.
const KEY_RE = /^(\s*(?:-\s+)?)([A-Za-z][\w-]*)(?:\([^)]*\))?\s*:/;
const MARK = '__actioKeyword';

const isActioBlock = (meta: { title?: unknown; __raw?: unknown } | undefined): boolean => {
  const haystack = `${meta?.title ?? ''} ${meta?.__raw ?? ''}`;
  return haystack.includes('.actio.yml');
};

type MarkableToken = ThemedToken & { [MARK]?: boolean };

export function transformerActioKeywords(): ShikiTransformer {
  return {
    name: 'actio:keywords',
    tokens(lines) {
      const lang = this.options.lang;
      if (lang !== 'yaml' && lang !== 'yml') return;
      if (!isActioBlock(this.options.meta)) return;

      for (const line of lines) {
        const text = line.map((token) => token.content).join('');
        const match = KEY_RE.exec(text);
        if (!match) continue;
        if (!ACTIO_KEYWORDS.has(match[2])) continue;

        const start = match[1].length;
        const end = start + match[2].length;
        let col = 0;
        for (const token of line as MarkableToken[]) {
          const tokenEnd = col + token.content.length;
          if (col < end && tokenEnd > start) token[MARK] = true;
          col = tokenEnd;
        }
      }
    },
    span(hast, _line, _col, _lineElement, token) {
      if ((token as MarkableToken)[MARK]) this.addClassToHast(hast, 'actio-keyword');
    },
  };
}

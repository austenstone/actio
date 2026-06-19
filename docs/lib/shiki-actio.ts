import type { ShikiTransformer, ThemedToken } from '@shikijs/types';

// Actio-only macro keywords (source spellings used across the docs examples).
// Underscore aliases are included defensively; the docs use hyphenated forms.
const ACTIO_KEYWORDS = new Set([
  'params',
  'fragments',
  'executors',
  'executor',
  'call-templates',
  'extends',
  'job-defaults',
  'dynamic-matrix',
  'static-if',
  'if-changed',
  'for-each',
  'inject',
  'retry',
  'fallback',
  'call_templates',
  'job_defaults',
  'dynamic_matrix',
  'static_if',
  'if_changed',
  'for_each',
]);

// Matches the first mapping key on a line, with an optional `- ` list marker.
const KEY_RE = /^(\s*(?:-\s+)?)([A-Za-z][\w-]*)\s*:/;
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

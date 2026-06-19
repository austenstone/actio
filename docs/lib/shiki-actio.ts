import type { ShikiTransformer, ThemedToken } from '@shikijs/types';
import { ACTIO_KEY_RE, ACTIO_KEYWORDS } from './actio-keywords';

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
        const match = ACTIO_KEY_RE.exec(text);
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

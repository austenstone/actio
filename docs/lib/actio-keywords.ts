// Single source of truth for Actio's macro keywords, shared by the Shiki
// transformer (static docs code blocks) and the Monaco playground (live editor).
// Keep this in sync with the keyword table in docs/content/docs/syntax.mdx —
// grouped by scope to make drift obvious.
export const ACTIO_KEYWORDS = new Set([
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
// only the keyword name (group 2) is captured, not the expression.
export const ACTIO_KEY_RE = /^(\s*(?:-\s+)?)([A-Za-z][\w-]*)(?:\([^)]*\))?\s*:/;

/** A keyword occurrence located by 1-based line/column (Monaco's coordinate space). */
export interface ActioKeywordRange {
  line: number;
  startColumn: number;
  /** Exclusive end column, as Monaco's Range expects. */
  endColumn: number;
}

/** Find every Actio keyword used as a mapping key across the given source text. */
export function findActioKeywordRanges(text: string): ActioKeywordRange[] {
  const ranges: ActioKeywordRange[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = ACTIO_KEY_RE.exec(lines[i]);
    if (!match || !ACTIO_KEYWORDS.has(match[2])) continue;
    const start = match[1].length;
    ranges.push({
      line: i + 1,
      startColumn: start + 1,
      endColumn: start + match[2].length + 1,
    });
  }
  return ranges;
}

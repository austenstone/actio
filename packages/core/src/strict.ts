import type { Diagnostic } from "./diagnostics.js";
import type { ParseContext } from "./parser.js";

const MERGE_KEY = "<<";

// A merge key surfaces in the kept CST (parser uses keepSourceTokens:true) as a
// plain scalar token whose verbatim source is exactly `<<`. Quoted scalars keep
// their quotes in `.source` (`"<<"`), so they never match.
const isMergeKeyToken = (token: unknown): token is { offset: number } => {
  const node = token as { type?: string; source?: string; offset?: number } | undefined;
  return (
    !!node && node.type === "scalar" && node.source === MERGE_KEY && typeof node.offset === "number"
  );
};

// Walk collection items so only key-position `<<` is reported; a stray `<<`
// used as a value (`foo: <<`) is left alone.
const walkTokens = (token: unknown, onMergeKey: (offset: number) => void): void => {
  if (!token || typeof token !== "object") return;
  const node = token as { items?: unknown[]; key?: unknown; value?: unknown };
  if (Array.isArray(node.items)) {
    for (const item of node.items) {
      const { key, value } = item as { key?: unknown; value?: unknown };
      if (isMergeKeyToken(key)) onMergeKey((key as { offset: number }).offset);
      walkTokens(value, onMergeKey);
      walkTokens(key, onMergeKey);
    }
  }
  walkTokens(node.value, onMergeKey);
};

/**
 * Flag YAML 1.1 merge keys (`<<`) in `.actio.yml` source for repos enforcing a
 * strict YAML 1.2.2 style. Lint-only: Actio still resolves and erases `<<` at
 * parse, so emitted YAML is byte-identical whether or not strict mode is on.
 * Anchors and aliases (`&`/`*`) are valid 1.2.2 core and are never flagged.
 */
export const collectMergeKeyDiagnostics = (ctx: ParseContext): Diagnostic[] => {
  const root = (ctx.doc.contents as { srcToken?: unknown } | null)?.srcToken;
  if (!root) return [];

  const diagnostics: Diagnostic[] = [];
  walkTokens(root, (offset) => {
    diagnostics.push({
      severity: "warning",
      source: "actio",
      file: ctx.fileName,
      range: {
        start: ctx.lineCounter.linePos(offset),
        end: ctx.lineCounter.linePos(offset + MERGE_KEY.length),
      },
      code: "yaml-merge-key",
      message: `YAML 1.1 merge key "${MERGE_KEY}" is not part of the YAML 1.2.2 core schema`,
      hint: 'Replace the merge with an Actio reuse macro (fragments/inject, job-defaults, executors, or extends), or plain YAML anchors and aliases ("&"/"*") which are valid 1.2.2. Actio still resolves and erases "<<" by default; this finding only appears under strict mode.',
    });
  });
  return diagnostics;
};

import type { Diagnostic, Range, Severity } from "./diagnostics.js";
import type { ParseContext } from "./parser.js";
import { isObject } from "./passes/helpers.js";

/** How loudly to report declared-but-unreferenced symbols. */
export type UnusedSymbolsMode = "off" | "warn" | "error";

type SymbolKind = "param" | "fragment" | "executor";

interface References {
  params: Set<string>;
  fragments: Set<string>;
  executors: Set<string>;
}

// A `params.<name>` root reference inside any string scalar — compile `{{ }}`,
// runtime `${{ }}`, or bare text. The lookbehind rejects dotted sub-paths
// (`steps.params.x`) and name substrings (`vars.myparams`); the name class
// mirrors the param grammar in passes/params.ts (hyphens allowed).
const PARAM_REF_RE = /(?<![\w.])params\.([A-Za-z_][A-Za-z0-9_-]*)/g;

// A comment carrying this marker on a declaration's key line opts that symbol
// out of the unused check — the escape hatch for intentionally-kept symbols.
const KEEP_RE = /#.*\bactio-keep\b/;

const HINTS: Record<SymbolKind, (name: string) => string> = {
  param: (name) =>
    `Reference it with {{ params.${name} }} or remove it. Add a "# actio-keep" comment on its declaration to silence this.`,
  fragment: (name) =>
    `Inject it with "- inject: ${name}" or remove it. Add a "# actio-keep" comment on its declaration to silence this.`,
  executor: (name) =>
    `Reference it from a job with "executor: ${name}" or remove it. Add a "# actio-keep" comment on its declaration to silence this.`,
};

const addExecutorRef = (value: unknown, refs: References): void => {
  if (typeof value === "string") {
    const name = value.trim();
    if (name) refs.executors.add(name);
  } else if (Array.isArray(value)) {
    for (const item of value) addExecutorRef(item, refs);
  }
};

/**
 * Walk the pristine model recording every reference to a param, fragment, or
 * executor. Scanning before passes run keeps references visible that later get
 * pruned — `static-if` branches, fragments injected into other fragments, and
 * conditional steps — so a live symbol is never mistaken for dead code.
 */
const collectReferences = (value: unknown, refs: References): void => {
  if (typeof value === "string") {
    for (const match of value.matchAll(PARAM_REF_RE)) {
      if (match[1]) refs.params.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, refs);
    return;
  }
  if (!isObject(value)) return;

  if (typeof value.inject === "string") refs.fragments.add(value.inject);
  if ("executor" in value) addExecutorRef(value.executor, refs);

  for (const child of Object.values(value)) collectReferences(child, refs);
};

const declaredNames = (block: unknown): string[] => (isObject(block) ? Object.keys(block) : []);

interface KeyLocation {
  range?: Range;
  line?: number;
}

/** Locate a declaration's key node so diagnostics point at the name, not its body. */
const keyLocation = (ctx: ParseContext, block: string, name: string): KeyLocation => {
  try {
    const map = ctx.doc.getIn([block], true) as
      | { items?: Array<{ key?: { value?: unknown; range?: [number, number, number] } }> }
      | undefined;
    for (const pair of map?.items ?? []) {
      const key = pair?.key;
      if (key && String(key.value) === name && key.range) {
        const [start, , end] = key.range;
        const startPos = ctx.lineCounter.linePos(start);
        const endPos = ctx.lineCounter.linePos(end);
        return {
          range: { start: startPos, end: endPos },
          line: startPos.line,
        };
      }
    }
  } catch {
    // best-effort; ranges are advisory
  }
  return {};
};

/**
 * Diagnose `params`, `fragments`, and `executors` that are declared but never
 * referenced. Returns warnings (or errors) for the caller to merge into the
 * compile result; returns nothing when the check is disabled.
 */
export const collectUnusedSymbolDiagnostics = (
  ctx: ParseContext,
  mode: UnusedSymbolsMode = "warn",
): Diagnostic[] => {
  if (mode === "off") return [];
  const severity: Severity = mode === "error" ? "error" : "warning";

  const refs: References = {
    params: new Set(),
    fragments: new Set(),
    executors: new Set(),
  };
  collectReferences(ctx.data, refs);

  const sourceLines = ctx.source.split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];

  const report = (block: string, kind: SymbolKind, referenced: Set<string>): void => {
    for (const name of declaredNames(ctx.data[block])) {
      if (referenced.has(name)) continue;
      const { range, line } = keyLocation(ctx, block, name);
      const declLine = line === undefined ? undefined : sourceLines[line - 1];
      if (declLine && KEEP_RE.test(declLine)) continue;
      diagnostics.push({
        severity,
        source: "actio",
        file: ctx.fileName,
        range,
        code: `unused-${kind}`,
        message: `Unused ${kind} "${name}" is declared but never referenced`,
        hint: HINTS[kind](name),
      });
    }
  };

  report("params", "param", refs.params);
  report("fragments", "fragment", refs.fragments);
  report("executors", "executor", refs.executors);

  return diagnostics;
};

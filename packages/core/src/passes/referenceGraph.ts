import type { ParseContext, Path } from "../parser.js";
import { pushDiagnostic } from "./helpers.js";

/**
 * The shared reference-graph engine. Both the `share` macro and the `ref.*`
 * passes are front-ends over these primitives: a runtime `${{ ... }}` scanner,
 * adjacency cycle/topo helpers, and the matrix-output clobber report. Keeping
 * them here means there is exactly one wiring engine, not a fork per front-end.
 */

export const isIdentStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
export const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
export const isSegPart = (ch: string): boolean => /[A-Za-z0-9_-]/.test(ch);

/** Find the index of the closing `}}`, respecting GitHub-expression string literals. */
export function findExprClose(s: string, from: number): number {
  let i = from;
  let quote = "";
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        if (s[i + 1] === quote) {
          i += 2;
          continue;
        }
        quote = "";
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "}" && s[i + 1] === "}") return i;
    i++;
  }
  return -1;
}

/** Rewrite every `${{ ... }}` body in `value` via `rewriteBody`, honoring `$${{ ... }}` escapes. */
export function scanRuntimeExprs(value: string, rewriteBody: (inner: string) => string): string {
  if (!value.includes("${{")) return value;
  let out = "";
  let cursor = 0;
  while (cursor <= value.length) {
    const open = value.indexOf("${{", cursor);
    if (open < 0) {
      out += value.slice(cursor);
      break;
    }
    if (open > 0 && value[open - 1] === "$") {
      out += value.slice(cursor, open - 1);
      const close = findExprClose(value, open + 3);
      if (close < 0) {
        out += value.slice(open);
        break;
      }
      out += value.slice(open, close + 2);
      cursor = close + 2;
      continue;
    }
    const close = findExprClose(value, open + 3);
    if (close < 0) {
      out += value.slice(cursor);
      break;
    }
    out += value.slice(cursor, open);
    const inner = value.slice(open + 3, close);
    out += `\${{${rewriteBody(inner)}}}`;
    cursor = close + 2;
  }
  return out;
}

/** Recursively rewrite every string leaf of `node` in place. */
export function walkStrings(node: unknown, fn: (s: string) => string): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === "string") node[i] = fn(v);
      else walkStrings(v, fn);
    }
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string") obj[k] = fn(v);
      else walkStrings(v, fn);
    }
  }
}

/**
 * Detect a directed cycle in `adj` (node -> successors). Returns the offending
 * cycle as a path of node names, or null when the graph is acyclic. Callers
 * build the adjacency so the same primitive serves `needs` edges and any other
 * dependency graph.
 */
export function detectCycle(adj: Map<string, Iterable<string>>): string[] | null {
  const color = new Map<string, number>(); // 0 unseen, 1 on-stack, 2 done
  const stack: string[] = [];
  const dfs = (n: string): string[] | null => {
    color.set(n, 1);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      const c = color.get(m) ?? 0;
      if (c === 1) return stack.slice(stack.indexOf(m));
      if (c === 0) {
        const found = dfs(m);
        if (found) return found;
      }
    }
    color.set(n, 2);
    stack.pop();
    return null;
  };
  for (const n of adj.keys()) {
    if ((color.get(n) ?? 0) === 0) {
      const found = dfs(n);
      if (found) return found;
    }
  }
  return null;
}

/** Kahn topological order of `adj` (node -> successors). Nodes in a cycle are dropped. */
export function topoOrder(adj: Map<string, Iterable<string>>): string[] {
  const indeg = new Map<string, number>();
  for (const n of adj.keys()) if (!indeg.has(n)) indeg.set(n, 0);
  for (const [, succ] of adj) {
    for (const m of succ) indeg.set(m, (indeg.get(m) ?? 0) + 1);
  }
  const queue = [...adj.keys()].filter((n) => (indeg.get(n) ?? 0) === 0);
  const out: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift() as string;
    out.push(n);
    for (const m of adj.get(n) ?? []) {
      const d = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  return out;
}

export interface MatrixClobberReport {
  jobId: string;
  name: string;
  path: Path;
  code: string;
  message: string;
}

/**
 * Emit the hard error for a job output that escapes a matrix job. GitHub
 * collapses a matrix job's entire `outputs:` map down to whichever leg finishes
 * last, so a cross-job-referenced matrix output silently loses every other leg's
 * value. Both the `share` guard and the `ref` wire pass funnel through here so
 * the diagnostic wording stays in lock-step; the `code`/`message` are caller
 * supplied so each front-end keeps its own diagnostic identity.
 */
export function reportMatrixOutputClobber(ctx: ParseContext, report: MatrixClobberReport): void {
  pushDiagnostic(ctx, "error", report.message, report.path, { code: report.code });
}

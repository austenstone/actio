import type { Diagnostic, Range } from "../diagnostics.js";
import type { Job, Step } from "../ir.js";
import { type ParseContext, type Path, rangeOfPath } from "../parser.js";

export type { Job, Step };

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function asStepArray(value: unknown): Step[] {
  return asArray(value).filter(isObject);
}

/** Heuristic: does this script reference look like a local file (vs an inline command)? */
export function looksLikePath(script: string): boolean {
  const s = script.trim();
  if (/^(\.\/|\.\.\/|\/|~\/)/.test(s)) return true;
  // A single token ending in a known script extension, no shell operators.
  if (/[|&;><]/.test(s)) return false;
  if (/\s/.test(s)) return false;
  return /\.(sh|js|mjs|cjs|ts|py|rb|ps1)$/.test(s);
}

function stripExprWrapper(cond: string): string {
  const t = cond.trim();
  if (t.startsWith("${{") && t.endsWith("}}")) {
    const inner = t.slice(3, -2);
    // Only unwrap a self-contained single expression. A lazy regex would span
    // interior delimiters (`${{ a }} && ${{ b }}` -> `a }} && ${{ b`), corrupting
    // multi-wrapper conditions; bail and leave them for validation to flag.
    if (!inner.includes("${{") && !inner.includes("}}")) return inner.trim();
  }
  return t;
}

function needsParens(expr: string): boolean {
  // Wrap only when a `||` sits at the top level (depth 0). GitHub allows the
  // spaceless `a||b` form, so a whitespace check misses it; tracking paren depth
  // also avoids double-wrapping an already-grouped `(a||b)`.
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === "|" && expr[i + 1] === "|") return true;
  }
  return false;
}

/** Combine GitHub `if` conditions with `&&`, normalizing `${{ }}` wrappers. */
export function combineIf(...conditions: (string | boolean | number | undefined | null)[]): string {
  const parts = conditions
    // Keep falsy booleans/numbers (`false`, `0` are valid "never run" gates);
    // only drop nullish operands and empty/whitespace strings.
    .filter((c) => c != null && !(typeof c === "string" && c.trim().length === 0))
    .map((c) => stripExprWrapper(String(c)));
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] ?? "";
  return parts.map((p) => (needsParens(p) ? `(${p})` : p)).join(" && ");
}

/** Union job `needs`, preserving order and returning an array. */
export function mergeNeeds(existing: unknown, add: string[]): string[] {
  const current =
    typeof existing === "string" ? [existing] : Array.isArray(existing) ? existing : [];
  const out: string[] = [...current];
  for (const n of add) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

const SLUG_RE = /[^a-z0-9]+/gi;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(SLUG_RE, "_")
    .replace(/^_+|_+$/g, "");
}

/** Ensure a step has a unique `id`, deriving one from its name when needed. */
export function ensureStepId(step: Step, used: Set<string>, fallbackBase: string): string {
  if (typeof step.id === "string" && step.id.length > 0) {
    used.add(step.id);
    return step.id;
  }
  const base =
    typeof step.name === "string" && step.name ? `step_${slugify(step.name)}` : fallbackBase;
  let id = base || fallbackBase;
  let n = 2;
  while (used.has(id)) {
    id = `${base}_${n++}`;
  }
  used.add(id);
  step.id = id;
  return id;
}

export function collectUsedStepIds(steps: Step[] | undefined): Set<string> {
  const used = new Set<string>();
  for (const s of steps ?? []) {
    if (s && typeof s.id === "string" && s.id) used.add(s.id);
  }
  return used;
}

export function pushDiagnostic(
  ctx: ParseContext,
  severity: Diagnostic["severity"],
  message: string,
  path?: Path,
  extra?: { hint?: string; range?: Range },
): void {
  const range = extra?.range ?? (path ? rangeOfPath(ctx, path) : undefined);
  ctx.diagnostics.push({
    severity,
    source: "actio",
    file: ctx.fileName,
    message,
    range,
    hint: extra?.hint,
  });
}

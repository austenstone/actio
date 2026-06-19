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

/**
 * Apply `fn` to a fallback container's step list, writing the result back in
 * place. A `fallback:` value is either a bare `Step[]` or `{ steps; recover? }`;
 * this centralizes that shape so passes (fragments, retry) transform fallback
 * steps without each re-deriving the union.
 */
export function mapFallbackSteps(
  container: { fallback?: unknown },
  fn: (steps: Step[]) => Step[],
): void {
  const fb = container.fallback;
  if (Array.isArray(fb)) {
    container.fallback = fn(asStepArray(fb));
  } else if (isObject(fb) && Array.isArray(fb.steps)) {
    fb.steps = fn(asStepArray(fb.steps));
  }
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
  // also avoids double-wrapping an already-grouped `(a||b)`. Parens and `|`
  // inside a string literal don't count: a stray `)` in a literal would corrupt
  // `depth` and hide a real top-level `||`. GitHub literals use single quotes
  // with `''` escaping; handle `"` defensively too.
  let depth = 0;
  let quote = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === quote) {
        // A doubled quote is an escaped quote, not the closing delimiter.
        if (expr[i + 1] === quote) i++;
        else quote = "";
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (depth === 0 && ch === "|" && expr[i + 1] === "|") {
      return true;
    }
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

export function sourcePathFor(
  ctx: ParseContext,
  node: object,
  fallbackPath?: Path,
  suffix: Path = [],
): Path | undefined {
  const base = ctx.origins.get(node)?.path ?? fallbackPath;
  return base ? [...base, ...suffix] : undefined;
}

export function pushDiagnostic(
  ctx: ParseContext,
  severity: Diagnostic["severity"],
  message: string,
  path?: Path,
  extra?: { hint?: string; range?: Range; code?: string },
): void {
  const range = extra?.range ?? (path ? rangeOfPath(ctx, path) : undefined);
  ctx.diagnostics.push({
    severity,
    source: "actio",
    file: ctx.fileName,
    message,
    range,
    hint: extra?.hint,
    code: extra?.code,
  });
}

/**
 * Assert `value` is a mapping, pushing a diagnostic (default severity `error`)
 * when it is not. Narrows the value so callers can read its keys afterwards.
 */
export function expectMapping(
  ctx: ParseContext,
  value: unknown,
  path: Path,
  opts: { message: string; severity?: Diagnostic["severity"]; code?: string; hint?: string },
): value is Record<string, unknown> {
  if (isObject(value)) return true;
  pushDiagnostic(ctx, opts.severity ?? "error", opts.message, path, {
    code: opts.code,
    hint: opts.hint,
  });
  return false;
}

/**
 * Push one diagnostic per key of `obj` that is not in `allowed`, returning the
 * list of offending keys so the caller can branch on it. The message is built
 * per key so call sites keep their exact wording.
 */
export function warnUnknownKeys(
  ctx: ParseContext,
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: Path,
  opts: {
    severity: Diagnostic["severity"];
    message: (key: string) => string;
    code?: string;
    hint?: (key: string) => string;
  },
): string[] {
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  for (const key of unknown) {
    pushDiagnostic(ctx, opts.severity, opts.message(key), [...path, key], {
      code: opts.code,
      hint: opts.hint?.(key),
    });
  }
  return unknown;
}

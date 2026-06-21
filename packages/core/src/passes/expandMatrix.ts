import { cloneNode, type Job, recordOrigin, type Workflow, workflow } from "../ir.js";
import { KEY_ORDER, type ParseContext, type Path, setKeyOrder } from "../parser.js";
import { isObject, pushDiagnostic, slugify } from "./helpers.js";
import type { Pass } from "./registry.js";

/** Max jobs a native GitHub Actions matrix may expand to. */
const GHA_MATRIX_CAP = 256;

type LegValues = Record<string, unknown>;

interface Leg {
  /** The axis values that form this leg's identity (drive the slug). */
  axes: LegValues;
  /** Full property bag: axes plus any include-injected extras. */
  props: LegValues;
}

interface ExpandedJob {
  slug: string;
  leg: Leg;
}

/** Registry of every expanded job, keyed by the original job id. */
type LegRegistry = Map<string, { axisKeys: string[]; legs: ExpandedJob[] }>;

function err(ctx: ParseContext, code: string, message: string, path: Path, hint?: string): void {
  pushDiagnostic(ctx, "error", `[${code}] ${message}`, path, { hint, code });
}

function jobKeyOrder(jobs: Record<string, unknown>): string[] {
  const recorded = (jobs as Record<symbol, unknown>)[KEY_ORDER] as string[] | undefined;
  if (!recorded) return Object.keys(jobs);
  const seen = new Set(recorded);
  return [...recorded.filter((k) => k in jobs), ...Object.keys(jobs).filter((k) => !seen.has(k))];
}

/** A string holding (or interpolating) a `${{ ... }}` runtime expression. */
function hasRuntimeExpr(value: unknown): boolean {
  return typeof value === "string" && value.includes("${{");
}

/** Detect a runtime expression anywhere in the matrix literal (axes or entries). */
function matrixIsRuntime(matrix: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(matrix)) {
    if (key === "include" || key === "exclude") {
      if (hasRuntimeExpr(value)) return true;
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (isObject(entry) && Object.values(entry).some(hasRuntimeExpr)) return true;
        }
      }
      continue;
    }
    if (hasRuntimeExpr(value)) return true;
    if (Array.isArray(value) && value.some(hasRuntimeExpr)) return true;
  }
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Cartesian product of `axes` in declared key/value order. */
function cartesian(axes: [string, unknown[]][]): LegValues[] {
  let out: LegValues[] = [{}];
  for (const [key, values] of axes) {
    const next: LegValues[] = [];
    for (const base of out) {
      for (const value of values) {
        next.push({ ...base, [key]: value });
      }
    }
    out = next;
  }
  return out;
}

/** Apply GHA exclude semantics: drop legs containing all key=value pairs of any entry. */
function applyExclude(legs: LegValues[], excludes: LegValues[]): LegValues[] {
  if (excludes.length === 0) return legs;
  return legs.filter(
    (leg) =>
      !excludes.some((ex) =>
        Object.entries(ex).every(([k, v]) => k in leg && deepEqual(leg[k], v)),
      ),
  );
}

/**
 * Apply GHA include semantics (after exclude). An include entry merges its props
 * into every existing leg it doesn't overwrite; if it merges into none, it is
 * appended as a new standalone leg. Later includes observe earlier additions.
 */
function applyInclude(base: Leg[], includes: LegValues[]): Leg[] {
  const legs = base;
  for (const inc of includes) {
    let merged = false;
    for (const leg of legs) {
      const overwrites = Object.entries(inc).some(
        ([k, v]) => k in leg.props && !deepEqual(leg.props[k], v),
      );
      if (overwrites) continue;
      for (const [k, v] of Object.entries(inc)) leg.props[k] = v;
      merged = true;
    }
    if (!merged) legs.push({ axes: { ...inc }, props: { ...inc } });
  }
  return legs;
}

/** Compute the ordered leg list for a job's matrix, or `undefined` on hard error. */
function computeLegs(
  ctx: ParseContext,
  jobId: string,
  matrix: Record<string, unknown>,
  matrixOrder: string[],
): { legs: Leg[]; axisKeys: string[] } | undefined {
  const path: Path = ["jobs", jobId, "strategy", "matrix"];
  const axes: [string, unknown[]][] = [];
  for (const key of matrixOrder) {
    if (key === "include" || key === "exclude") continue;
    const value = matrix[key];
    if (!Array.isArray(value)) {
      err(
        ctx,
        "expand-matrix-bad-axis",
        `Job "${jobId}": matrix axis "${key}" must be an array of values`,
        [...path, key],
      );
      return undefined;
    }
    axes.push([key, value]);
  }
  const axisKeys = axes.map(([k]) => k);

  const excludeRaw = matrix.exclude;
  const includeRaw = matrix.include;
  const excludes = Array.isArray(excludeRaw) ? excludeRaw.filter(isObject) : [];
  const includes = Array.isArray(includeRaw) ? includeRaw.filter(isObject) : [];

  const product = applyExclude(cartesian(axes), excludes);
  const base: Leg[] = product.map((axesVals) => ({ axes: axesVals, props: { ...axesVals } }));
  const legs = applyInclude(base, includes);

  if (legs.length === 0) {
    err(
      ctx,
      "expand-matrix-empty",
      `Job "${jobId}": expand_matrix produced no jobs (empty matrix after include/exclude)`,
      path,
    );
    return undefined;
  }
  return { legs, axisKeys };
}

function legSlug(jobId: string, leg: Leg, axisKeys: string[]): string {
  const keys = axisKeys.length > 0 ? axisKeys : Object.keys(leg.props);
  const parts = keys.map((k) => slugify(String(leg.props[k])));
  return [jobId, ...parts].join("-");
}

// --- ${{ matrix.* }} rewriting -------------------------------------------------

/** A `matrix` reference: `matrix` followed by ≥1 `.key` or `['key']`/`[0]` segments. */
const MATRIX_REF = /matrix(?:\s*\.\s*[A-Za-z0-9_-]+|\s*\[\s*(?:'[^']*'|"[^"]*"|\d+)\s*\])+/;
const MATRIX_REF_G = new RegExp(MATRIX_REF.source, "g");

/** Resolve a `matrix.<path>` reference against a leg; `undefined` if not resolvable. */
function resolveMatrixRef(ref: string, props: LegValues): { value: unknown } | undefined {
  let rest = ref.slice("matrix".length);
  let current: unknown = props;
  let resolvedAny = false;
  while (rest.length > 0) {
    rest = rest.replace(/^\s+/, "");
    let key: string;
    if (rest.startsWith(".")) {
      const seg = rest.slice(1).match(/^[A-Za-z0-9_-]+/);
      if (!seg) return undefined;
      key = seg[0];
      rest = rest.slice(1 + key.length);
    } else if (rest.startsWith("[")) {
      const seg = rest.match(/^\[\s*(?:'([^']*)'|"([^"]*)"|([0-9]+))\s*\]/);
      if (!seg) return undefined;
      key = seg[1] ?? seg[2] ?? seg[3] ?? "";
      rest = rest.slice(seg[0].length);
    } else {
      return undefined;
    }
    if (Array.isArray(current)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (isObject(current) && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
    resolvedAny = true;
  }
  return resolvedAny ? { value: current } : undefined;
}

/** Render a leg value as a GitHub-expression literal (for compound interpolation). */
function exprLiteral(value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "null";
  return `fromJSON('${JSON.stringify(value).replace(/'/g, "''")}')`;
}

/**
 * Find the matching `}}` for a `${{` at `from`, ignoring `}}` inside single or
 * double quoted string literals. Returns the index just past `}}`, or -1.
 */
function exprEnd(text: string, from: number): number {
  let i = from + 3;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") i += 1;
        else quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "}" && text[i + 1] === "}") {
      return i + 2;
    }
    i += 1;
  }
  return -1;
}

/** If `inner` is exactly one matrix reference, return its resolved value. */
function soleRef(inner: string, props: LegValues): { value: unknown } | undefined {
  const m = inner.match(MATRIX_REF);
  if (m?.index !== 0 || m[0].length !== inner.length) return undefined;
  return resolveMatrixRef(inner, props);
}

/** Replace every `matrix.<path>` sub-reference inside an expression with a literal. */
function substituteInExpr(inner: string, props: LegValues): string {
  return inner.replace(MATRIX_REF_G, (ref) => {
    const resolved = resolveMatrixRef(ref, props);
    return resolved ? exprLiteral(resolved.value) : ref;
  });
}

/**
 * Rewrite a single string field. If the whole field is exactly one `${{ matrix.x }}`
 * token, return the type-preserved value. Otherwise rewrite each token in place
 * (text interpolation → value text; compound → expression literals).
 */
function rewriteString(value: string, props: LegValues): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("${{") && exprEnd(trimmed, 0) === trimmed.length) {
    const sole = soleRef(trimmed.slice(3, -2).trim(), props);
    if (sole) return sole.value;
  }

  let out = "";
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf("${{", i);
    if (start === -1) {
      out += value.slice(i);
      break;
    }
    const end = exprEnd(value, start);
    if (end === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, start);
    const inner = value.slice(start + 3, end - 2).trim();
    const sole = soleRef(inner, props);
    if (sole) {
      out += stringifyValue(sole.value);
    } else {
      out += `\${{ ${substituteInExpr(inner, props)} }}`;
    }
    i = end;
  }
  return out;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (isObject(value) || Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

/** Recursively rewrite `${{ matrix.* }}` references in every string of a node. */
function rewriteMatrixRefs(node: unknown, props: LegValues): unknown {
  if (typeof node === "string") return rewriteString(node, props);
  if (Array.isArray(node)) return node.map((item) => rewriteMatrixRefs(item, props));
  if (isObject(node)) {
    for (const key of Object.keys(node)) {
      node[key] = rewriteMatrixRefs(node[key], props);
    }
    return node;
  }
  return node;
}

// --- needs selector ------------------------------------------------------------

interface Selector {
  base: string;
  pairs: [string, string][];
}

/** Parse `id(k=v, k2=v2)`; returns `undefined` for a plain job id (no parens). */
function parseSelector(entry: string): Selector | undefined {
  const open = entry.indexOf("(");
  if (open === -1) return undefined;
  if (!entry.trimEnd().endsWith(")")) return { base: entry, pairs: [] }; // malformed → flagged later
  const base = entry.slice(0, open).trim();
  const body = entry.slice(open + 1, entry.lastIndexOf(")"));
  const pairs: [string, string][] = [];
  if (body.trim() !== "") {
    for (const part of splitPairs(body)) {
      const eq = part.indexOf("=");
      if (eq === -1) {
        pairs.push([part.trim(), ""]);
        continue;
      }
      const key = part.slice(0, eq).trim();
      pairs.push([key, unquote(part.slice(eq + 1).trim())]);
    }
  }
  return { base, pairs };
}

/** Split selector pairs on commas that are not inside quotes. */
function splitPairs(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.filter((p) => p.trim() !== "");
}

function unquote(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Resolve a selector to concrete slugs, or push a diagnostic and return undefined. */
function resolveSelector(
  ctx: ParseContext,
  selector: Selector,
  registry: LegRegistry,
  path: Path,
): string[] | undefined {
  const entry = registry.get(selector.base);
  if (!entry) {
    err(
      ctx,
      "expand-matrix-unknown-selector",
      `needs selector "${selector.base}(...)" does not target an expand_matrix job`,
      path,
    );
    return undefined;
  }
  for (const [key] of selector.pairs) {
    if (!entry.axisKeys.includes(key)) {
      err(
        ctx,
        "expand-matrix-unknown-key",
        `needs selector "${selector.base}(...)": "${key}" is not a matrix axis (axes: ${entry.axisKeys.join(", ")})`,
        path,
      );
      return undefined;
    }
  }
  const matches = entry.legs.filter((ej) =>
    selector.pairs.every(([k, v]) => String(ej.leg.props[k]) === v),
  );
  if (matches.length === 0) {
    err(
      ctx,
      "expand-matrix-no-match",
      `needs selector "${selector.base}(${selector.pairs
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")})" matched no expanded leg`,
      path,
    );
    return undefined;
  }
  return matches.map((m) => m.slug);
}

/** Rewrite a job's `needs`, expanding any leg selectors into concrete slugs. */
function rewriteNeeds(ctx: ParseContext, jobId: string, job: Job, registry: LegRegistry): void {
  const raw = job.needs;
  if (raw === undefined) return;
  const entries = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const path: Path = ["jobs", jobId, "needs"];
  const out: string[] = [];
  let changed = false;
  for (const entry of entries) {
    if (typeof entry !== "string") {
      out.push(entry as string);
      continue;
    }
    const selector = parseSelector(entry);
    if (!selector) {
      if (!out.includes(entry)) out.push(entry);
      continue;
    }
    changed = true;
    const slugs = resolveSelector(ctx, selector, registry, path);
    if (!slugs) {
      if (!out.includes(entry)) out.push(entry); // keep input so output stays inspectable
      continue;
    }
    for (const slug of slugs) if (!out.includes(slug)) out.push(slug);
  }
  if (changed) job.needs = out.length === 1 ? out[0] : out;
}

// --- main pass -----------------------------------------------------------------

function expandOne(
  ctx: ParseContext,
  jobId: string,
  job: Job,
  existingIds: Set<string>,
  rebuilt: Record<string, unknown>,
  rebuiltOrder: string[],
  registry: LegRegistry,
): boolean {
  const path: Path = ["jobs", jobId, "expand_matrix"];
  const strategy = job.strategy;
  const matrix = isObject(strategy) ? strategy.matrix : undefined;
  if (typeof matrix === "string" && hasRuntimeExpr(matrix)) {
    err(
      ctx,
      "expand-matrix-runtime",
      `Job "${jobId}": expand_matrix needs a compile-time matrix; runtime matrices (\${{ ... }}) stay native`,
      ["jobs", jobId, "strategy", "matrix"],
    );
    return false;
  }
  if (!isObject(matrix)) {
    err(
      ctx,
      "expand-matrix-no-matrix",
      `Job "${jobId}": expand_matrix requires a literal strategy.matrix mapping`,
      path,
    );
    return false;
  }
  if (matrixIsRuntime(matrix)) {
    err(
      ctx,
      "expand-matrix-runtime",
      `Job "${jobId}": expand_matrix needs a compile-time matrix; runtime expressions (\${{ ... }}) stay native`,
      ["jobs", jobId, "strategy", "matrix"],
    );
    return false;
  }

  const matrixOrder = jobKeyOrder(matrix as Record<string, unknown>);
  const computed = computeLegs(ctx, jobId, matrix as Record<string, unknown>, matrixOrder);
  if (!computed) return false;
  const { legs, axisKeys } = computed;

  if (legs.length > GHA_MATRIX_CAP) {
    err(
      ctx,
      "expand-matrix-too-many-legs",
      `Job "${jobId}": expand_matrix would emit ${legs.length} jobs, over GitHub's ${GHA_MATRIX_CAP}-job matrix cap`,
      path,
      "Reduce the matrix, or split the fan-out across workflows.",
    );
    return false;
  }

  // Slug + collision check up front so we never partially expand.
  const expanded: ExpandedJob[] = [];
  const localSlugs = new Set<string>();
  for (const leg of legs) {
    const slug = legSlug(jobId, leg, axisKeys);
    const collides = localSlugs.has(slug) || (existingIds.has(slug) && slug !== jobId);
    if (collides) {
      err(
        ctx,
        "expand-matrix-slug-collision",
        `Job "${jobId}": expanded leg slug "${slug}" collides with ${
          localSlugs.has(slug) ? "another leg" : `existing job "${slug}"`
        }`,
        path,
      );
      return false;
    }
    localSlugs.add(slug);
    expanded.push({ slug, leg });
  }

  for (const { slug, leg } of expanded) {
    const legJob = cloneNode(ctx, job) as Job;
    delete legJob.expand_matrix;
    delete legJob.strategy;
    rewriteMatrixRefs(legJob, leg.props);
    recordOrigin(ctx, legJob, ["jobs", jobId]);
    rebuilt[slug] = legJob;
    rebuiltOrder.push(slug);
    existingIds.add(slug);
  }
  registry.set(jobId, { axisKeys, legs: expanded });
  return true;
}

export function expandMatrixPass(ctx: ParseContext): void {
  const wf: Workflow = workflow(ctx);
  const jobs = wf.jobs;
  if (!isObject(jobs)) return;

  const order = jobKeyOrder(jobs as Record<string, unknown>);
  const hasExpand = order.some((id) => {
    const job = (jobs as Record<string, unknown>)[id];
    return isObject(job) && (job as Job).expand_matrix != null && (job as Job).expand_matrix;
  });
  if (!hasExpand) return;

  const existingIds = new Set(order);
  const registry: LegRegistry = new Map();
  const rebuilt: Record<string, unknown> = {};
  const rebuiltOrder: string[] = [];

  for (const jobId of order) {
    const job = (jobs as Record<string, unknown>)[jobId];
    if (!isObject(job) || !(job as Job).expand_matrix) {
      rebuilt[jobId] = job;
      rebuiltOrder.push(jobId);
      continue;
    }
    existingIds.delete(jobId);
    const ok = expandOne(ctx, jobId, job as Job, existingIds, rebuilt, rebuiltOrder, registry);
    if (!ok) {
      // Leave the job intact (minus the macro key) so emit/validation still proceed.
      delete (job as Job).expand_matrix;
      existingIds.add(jobId);
      rebuilt[jobId] = job;
      rebuiltOrder.push(jobId);
    }
  }

  setKeyOrder(rebuilt, rebuiltOrder);
  wf.jobs = rebuilt as Record<string, Job>;

  // Second walk: rewrite leg selectors in every (final) job's needs.
  for (const jobId of rebuiltOrder) {
    const job = rebuilt[jobId];
    if (isObject(job)) rewriteNeeds(ctx, jobId, job as Job, registry);
  }
}

/** Unroll a compile-time `strategy.matrix` into discrete named jobs. */
export const expandMatrix: Pass = {
  name: "expand-matrix",
  runsAfter: [
    "params",
    "job-defaults",
    "for-each",
    "fragments",
    "retry",
    "fallback",
    "dynamic-matrix",
  ],
  apply: expandMatrixPass,
};

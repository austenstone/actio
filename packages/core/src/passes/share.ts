import { visitJobs } from "../ir.js";
import type { ParseContext, Path, WorkflowData } from "../parser.js";
import { conservativeTaint, type SymbolDef, type TaintFacet } from "../symbols.js";
import {
  collectUsedStepIds,
  ensureStepId,
  isObject,
  type Job,
  mergeNeeds,
  pushDiagnostic,
  slugify,
} from "./helpers.js";
import type { Pass } from "./registry.js";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const OBJECT_KEYS: ReadonlySet<string> = new Set(["value", "run", "json", "required", "type"]);
const SHARE_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean", "object"]);

interface Producer {
  jobId: string;
  stepId: string;
  json: boolean;
}

interface NormalizedShare {
  mode: "value" | "capture";
  /** Value-form: the scalar source text. Capture-form: the command whose stdout is captured. */
  source: string;
  json: boolean;
  required: boolean;
  secret: boolean;
}

/** FNV-1a hash rendered as a short, stable base36 suffix for heredoc delimiters. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(6, "0").slice(-6);
}

function upperSnake(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/**
 * A deterministic per-output heredoc delimiter. The brief asks for a per-output
 * delimiter "plus a short random suffix"; a literally random suffix would break
 * Actio's reproducible-output invariant, so the suffix is a stable content hash
 * of the captured command instead.
 */
function heredocDelimiter(name: string, command: string): string {
  return `ACTIO_EOF_${upperSnake(name)}_${shortHash(command)}`;
}

/** `echo "<name>=<value>" >> "$GITHUB_OUTPUT"`, the canonical single-value writer. */
function valueWriter(name: string, value: string): string {
  return `echo "${name}=${value}" >> "$GITHUB_OUTPUT"`;
}

/** A runtime guard that fails the step when a `required` share value is empty. */
function requiredGuard(value: string): string {
  return `[ -n "${value}" ] || { echo "::error::empty share value"; exit 1; }`;
}

/** A heredoc block that captures a command's stdout into `$GITHUB_OUTPUT`. */
function captureWriter(name: string, command: string): string {
  const delimiter = heredocDelimiter(name, command);
  const body = command
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return [
    "{",
    `  echo '${name}<<${delimiter}'`,
    body,
    `  echo ${delimiter}`,
    '} >> "$GITHUB_OUTPUT"',
  ].join("\n");
}

function mentionsSecret(text: string): boolean {
  return /\bsecrets\./.test(text);
}

/** Resolve a `share:` entry's raw spec into a normalized value/capture descriptor. */
function normalizeShare(
  ctx: ParseContext,
  name: string,
  spec: unknown,
  path: Path,
): NormalizedShare | undefined {
  if (typeof spec === "string" || typeof spec === "number" || typeof spec === "boolean") {
    const text = String(spec);
    // A multiline string is shorthand for capture-form `{ run: <block> }`.
    const mode = typeof spec === "string" && spec.includes("\n") ? "capture" : "value";
    return { mode, source: text, json: false, required: false, secret: mentionsSecret(text) };
  }
  if (!isObject(spec)) {
    pushDiagnostic(ctx, "error", `share.${name} must be a scalar or a mapping`, path, {
      code: "E-share-shape",
    });
    return undefined;
  }
  for (const key of Object.keys(spec)) {
    if (!OBJECT_KEYS.has(key)) {
      pushDiagnostic(
        ctx,
        "warning",
        `share.${name}: unknown key "${key}" ignored`,
        [...path, key],
        {
          code: "W-share-unknown-key",
        },
      );
    }
  }
  if (spec.type !== undefined && (typeof spec.type !== "string" || !SHARE_TYPES.has(spec.type))) {
    pushDiagnostic(
      ctx,
      "error",
      `share.${name}.type must be one of string|number|boolean|object`,
      [...path, "type"],
      { code: "E-share-shape" },
    );
    return undefined;
  }
  const json = spec.json === true;
  const required = spec.required === true;
  if (typeof spec.run === "string") {
    return { mode: "capture", source: spec.run, json, required, secret: mentionsSecret(spec.run) };
  }
  if (
    typeof spec.value === "string" ||
    typeof spec.value === "number" ||
    typeof spec.value === "boolean"
  ) {
    const text = String(spec.value);
    return { mode: "value", source: text, json, required, secret: mentionsSecret(text) };
  }
  pushDiagnostic(ctx, "error", `share.${name} must declare a "value" or "run" source`, path, {
    code: "E-share-shape",
  });
  return undefined;
}

function symbolType(norm: NormalizedShare, spec: unknown): SymbolDef["type"] {
  if (isObject(spec) && typeof spec.type === "string" && SHARE_TYPES.has(spec.type)) {
    return spec.type as SymbolDef["type"];
  }
  return norm.json ? "object" : "string";
}

/** Collect every producer in a job, rewriting producer steps to emit `$GITHUB_OUTPUT` writers. */
function collectJob(
  ctx: ParseContext,
  jobId: string,
  job: Job,
  producers: Map<string, Producer[]>,
): void {
  if (job.share !== undefined) {
    pushDiagnostic(
      ctx,
      "warning",
      `Job "${jobId}": share must be declared on a step, not a job`,
      ["jobs", jobId, "share"],
      { code: "W-share-on-job" },
    );
    delete job.share;
  }
  if (!Array.isArray(job.steps)) return;
  const usedIds = collectUsedStepIds(job.steps);
  const isMatrix = isObject(job.strategy) && job.strategy.matrix !== undefined;
  const seen = new Set<string>();

  job.steps.forEach((step, index) => {
    if (!isObject(step) || step.share === undefined) return;
    const share = step.share;
    const sharePath: Path = ["jobs", jobId, "steps", index, "share"];
    if (!isObject(share)) {
      pushDiagnostic(
        ctx,
        "error",
        `share must be a mapping of output names to sources`,
        sharePath,
        {
          code: "E-share-shape",
        },
      );
      delete step.share;
      return;
    }
    const writers: string[] = [];
    let stepId: string | undefined;
    for (const [name, spec] of Object.entries(share)) {
      const entryPath: Path = [...sharePath, name];
      if (!NAME_RE.test(name)) {
        pushDiagnostic(ctx, "error", `Invalid share name "${name}"`, entryPath, {
          code: "E-share-invalid-name",
          hint: "Names must match /^[A-Za-z_][A-Za-z0-9_-]*$/",
        });
        continue;
      }
      if (seen.has(name)) {
        pushDiagnostic(
          ctx,
          "error",
          `Duplicate share name "${name}" in job "${jobId}"`,
          entryPath,
          {
            code: "E-share-duplicate-name",
          },
        );
        continue;
      }
      const norm = normalizeShare(ctx, name, spec, entryPath);
      if (!norm) continue;
      seen.add(name);
      if (isMatrix) {
        pushDiagnostic(
          ctx,
          "warning",
          `share "${name}" is produced by a matrix job; parallel legs overwrite the output`,
          entryPath,
          { code: "W-share-matrix" },
        );
      }
      if (norm.secret) {
        pushDiagnostic(
          ctx,
          "warning",
          `share "${name}" is derived from secrets and will be written to job outputs`,
          entryPath,
          { code: "W-share-secret" },
        );
      }
      stepId ??= ensureStepId(step, usedIds, `step_${slugify(name) || "share"}`);
      if (norm.mode === "value") {
        writers.push(valueWriter(name, norm.source));
        if (norm.required) writers.push(requiredGuard(norm.source));
      } else {
        // TODO(share-foreach-integration): per-iteration renamed outputs from
        // ctx.internal.forEachShareContracts plug in here once #20's seam is testable.
        writers.push(captureWriter(name, norm.source));
      }
      const taint: TaintFacet = norm.secret
        ? { tainted: true, derivedFrom: ["secrets"] }
        : conservativeTaint();
      const symbol: SymbolDef = {
        name,
        kind: "shared-output",
        type: symbolType(norm, spec),
        compileTimeKnown: false,
        required: norm.required,
        taint,
      };
      ctx.symbols.set(name, symbol);
      const list = producers.get(name) ?? [];
      list.push({ jobId, stepId, json: norm.json });
      producers.set(name, list);
    }
    delete step.share;
    if (writers.length > 0) {
      const existing = typeof step.run === "string" ? step.run : undefined;
      step.run = existing ? `${existing}\n${writers.join("\n")}` : writers.join("\n");
    }
  });
}

interface ScanState {
  producers: Map<string, Producer[]>;
  jobIds: Set<string>;
  crossRefs: Set<string>;
  needs: Map<string, Set<string>>;
}

function crossKey(jobId: string, name: string): string {
  return `${jobId}\u0000${name}`;
}

/** Find the index of the `}}` that closes a `${{` opened at `from`, skipping quoted literals. */
function findClose(text: string, from: number): number {
  let quote = "";
  for (let index = from; index < text.length - 1; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          index++;
          continue;
        }
        if (quote === '"' && text[index - 1] === "\\") continue;
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "}" && text[index + 1] === "}") return index;
  }
  return -1;
}

/** Resolve a single `share.<path>` token into its rewritten expression (no `${{ }}` wrapper). */
function resolveRefExpr(
  ctx: ParseContext,
  token: string,
  consumerJobId: string | undefined,
  path: Path,
  state: ScanState,
): string {
  const segments = token.slice("share.".length).split(".");
  const head = segments[0] as string;
  let producer: Producer | undefined;
  let name: string;
  let fields: string[];
  const qualifiedName = segments[1];
  if (
    segments.length >= 2 &&
    qualifiedName !== undefined &&
    state.jobIds.has(head) &&
    (state.producers.get(qualifiedName) ?? []).some((p) => p.jobId === head)
  ) {
    name = qualifiedName;
    fields = segments.slice(2);
    producer = (state.producers.get(name) ?? []).find((p) => p.jobId === head);
  } else {
    name = head;
    fields = segments.slice(1);
    const candidates = state.producers.get(name) ?? [];
    if (candidates.length === 0) {
      const available = [...state.producers.keys()].sort();
      pushDiagnostic(ctx, "error", `Unknown share "${name}"`, path, {
        code: "E-share-unknown",
        hint: available.length ? `Available: ${available.join(", ")}` : "No share outputs declared",
      });
      return token;
    }
    if (candidates.length > 1) {
      const jobs = candidates.map((c) => c.jobId).join(", ");
      pushDiagnostic(ctx, "error", `Ambiguous share "${name}" (produced by ${jobs})`, path, {
        code: "E-share-ambiguous",
        hint: `Qualify it as \${{ share.<job>.${name} }}`,
      });
      return token;
    }
    producer = candidates[0];
  }
  if (!producer) return token;
  if (fields.length > 0 && !producer.json) {
    pushDiagnostic(
      ctx,
      "error",
      `share "${name}" is not JSON; cannot access ".${fields.join(".")}"`,
      path,
      {
        code: "E-share-dotted-non-json",
        hint: "Add `json: true` to the producer.",
      },
    );
    return token;
  }
  const sameJob = consumerJobId !== undefined && producer.jobId === consumerJobId;
  const base = sameJob
    ? `steps.${producer.stepId}.outputs.${name}`
    : `needs.${producer.jobId}.outputs.${name}`;
  if (!sameJob) {
    state.crossRefs.add(crossKey(producer.jobId, name));
    if (consumerJobId !== undefined) {
      const set = state.needs.get(consumerJobId) ?? new Set<string>();
      set.add(producer.jobId);
      state.needs.set(consumerJobId, set);
    }
  }
  return fields.length > 0 ? `fromJSON(${base})${fields.map((f) => `.${f}`).join("")}` : base;
}

const SHARE_TOKEN = /share(?:\.[A-Za-z0-9_-]+)+/y;

/** Rewrite share tokens inside one `${{ ... }}` body, skipping quoted literals. */
function rewriteExpr(
  ctx: ParseContext,
  inner: string,
  consumerJobId: string | undefined,
  path: Path,
  state: ScanState,
): { expr: string; changed: boolean } {
  let out = "";
  let index = 0;
  let quote = "";
  let changed = false;
  while (index < inner.length) {
    const char = inner[index];
    if (quote) {
      out += char;
      if (char === quote) {
        if (quote === "'" && inner[index + 1] === "'") {
          out += "'";
          index += 2;
          continue;
        }
        if (!(quote === '"' && inner[index - 1] === "\\")) quote = "";
      }
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      index++;
      continue;
    }
    const boundary = index === 0 || !/[A-Za-z0-9_]/.test(inner[index - 1] ?? "");
    if (boundary && inner.startsWith("share", index)) {
      SHARE_TOKEN.lastIndex = index;
      const match = SHARE_TOKEN.exec(inner);
      if (match) {
        out += resolveRefExpr(ctx, match[0], consumerJobId, path, state);
        index += match[0].length;
        changed = true;
        continue;
      }
    }
    out += char;
    index++;
  }
  return { expr: out, changed };
}

/** Rewrite every `${{ ... }}` block carrying a `share.*` token, honoring `$${{ ... }}` escapes. */
function rewriteString(
  ctx: ParseContext,
  raw: string,
  consumerJobId: string | undefined,
  path: Path,
  state: ScanState,
): string {
  if (!raw.includes("${{")) return raw;
  let out = "";
  let cursor = 0;
  while (cursor < raw.length) {
    const open = raw.indexOf("${{", cursor);
    if (open === -1) {
      out += raw.slice(cursor);
      break;
    }
    const close = findClose(raw, open + 3);
    if (close === -1) {
      out += raw.slice(cursor);
      break;
    }
    const inner = raw.slice(open + 3, close).trim();
    const full = raw.slice(open, close + 2);
    const escaped = open > 0 && raw[open - 1] === "$";
    if (escaped) {
      out += raw.slice(cursor, open - 1) + full;
      cursor = close + 2;
      continue;
    }
    if (inner.includes("share")) {
      const { expr, changed } = rewriteExpr(ctx, inner, consumerJobId, path, state);
      out += raw.slice(cursor, open);
      out += changed ? `\${{ ${expr} }}` : full;
    } else {
      out += raw.slice(cursor, close + 2);
    }
    cursor = close + 2;
  }
  return out;
}

function jobIdOfPath(path: Path): string | undefined {
  return path[0] === "jobs" && typeof path[1] === "string" ? path[1] : undefined;
}

function scanTree(ctx: ParseContext, value: unknown, path: Path, state: ScanState): unknown {
  if (typeof value === "string") {
    return rewriteString(ctx, value, jobIdOfPath(path), path, state);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      value[index] = scanTree(ctx, item, [...path, index], state);
    });
    return value;
  }
  if (isObject(value)) {
    for (const key of Object.keys(value)) {
      value[key] = scanTree(ctx, value[key], [...path, key], state);
    }
    return value;
  }
  return value;
}

/** Detect a cycle in the merged job `needs` graph, reporting the offending job. */
function assertAcyclic(ctx: ParseContext, jobs: Record<string, unknown>): void {
  const graph = new Map<string, string[]>();
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObject(job)) continue;
    const needs = job.needs;
    const list = typeof needs === "string" ? [needs] : Array.isArray(needs) ? needs : [];
    graph.set(
      jobId,
      list.filter((n): n is string => typeof n === "string"),
    );
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  let cycleAt: string | undefined;
  const visit = (node: string): boolean => {
    if (done.has(node)) return false;
    if (visiting.has(node)) {
      cycleAt = node;
      return true;
    }
    visiting.add(node);
    for (const dep of graph.get(node) ?? []) {
      if (visit(dep)) return true;
    }
    visiting.delete(node);
    done.add(node);
    return false;
  };
  for (const jobId of graph.keys()) {
    if (visit(jobId)) {
      pushDiagnostic(
        ctx,
        "error",
        `share wiring created a needs cycle at job "${cycleAt}"`,
        ["jobs", cycleAt ?? jobId],
        { code: "E-share-needs-cycle" },
      );
      return;
    }
  }
}

export function sharePass(ctx: ParseContext): void {
  const producers = new Map<string, Producer[]>();
  visitJobs(ctx, ({ id, job }) => collectJob(ctx, id, job, producers));
  if (producers.size === 0) return;

  const jobsObj = isObject(ctx.data.jobs) ? ctx.data.jobs : {};
  const state: ScanState = {
    producers,
    jobIds: new Set(Object.keys(jobsObj)),
    crossRefs: new Set(),
    needs: new Map(),
  };
  ctx.data = scanTree(ctx, ctx.data, [], state) as WorkflowData;

  for (const key of state.crossRefs) {
    const [jobId, name] = key.split("\u0000");
    if (!jobId || name === undefined) continue;
    const job = jobsObj[jobId];
    const producer = (producers.get(name) ?? []).find((p) => p.jobId === jobId);
    if (!isObject(job) || !producer) continue;
    const outputs = isObject(job.outputs) ? job.outputs : {};
    outputs[name] = `\${{ steps.${producer.stepId}.outputs.${name} }}`;
    job.outputs = outputs;
  }

  for (const [consumerJobId, deps] of state.needs) {
    const job = jobsObj[consumerJobId];
    if (!isObject(job)) continue;
    job.needs = mergeNeeds(job.needs, [...deps]);
  }

  assertAcyclic(ctx, jobsObj);
}

/**
 * share pass: turns `share:` step declarations into `$GITHUB_OUTPUT` writers and
 * rewrites `${{ share.* }}` consumers into `steps`/`needs` references, inferring
 * `job.outputs` and `needs` edges. Runs after fragments so fragment-injected
 * steps participate; retry/fallback/dynamic_matrix run after it.
 */
export const share: Pass = {
  name: "share",
  runsAfter: ["fragments"],
  apply: sharePass,
};

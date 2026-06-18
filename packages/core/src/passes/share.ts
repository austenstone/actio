import { type Job, visitJobs, workflow } from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import type { ParamType } from "../symbols.js";
import {
  collectUsedStepIds,
  ensureStepId,
  expectMapping,
  isObject,
  mergeNeeds,
  pushDiagnostic,
  slugify,
} from "./helpers.js";
import type { Pass } from "./registry.js";

/**
 * The runtime output-writer primitive — the seam `for_each` reuses to emit a
 * per-iteration writer under a distinct name. It holds no global state: it
 * writes whatever name it is handed.
 */
export type OutputWriterSpec =
  | { kind: "value"; name: string; value: string; required?: boolean }
  | { kind: "capture"; name: string; body: string; delimiter: string };

/** Build the shell that writes a single shared output to `$GITHUB_OUTPUT`. */
export function buildOutputWriter(spec: OutputWriterSpec): string {
  if (spec.kind === "value") {
    const line = `echo "${spec.name}=${spec.value}" >> "$GITHUB_OUTPUT"`;
    if (spec.required) {
      return `${line}\n[ -n "${spec.value}" ] || { echo "::error::empty share value"; exit 1; }`;
    }
    return line;
  }
  const body = spec.body
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return [
    "{",
    `  echo '${spec.name}<<${spec.delimiter}'`,
    body,
    `  echo ${spec.delimiter}`,
    '} >> "$GITHUB_OUTPUT"',
  ].join("\n");
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PARAM_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean", "enum", "object"]);

/** Deterministic FNV-1a (32-bit) hash, hex, first 6 chars — for heredoc delimiter uniqueness. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

interface Producer {
  jobId: string;
  job: Job;
  stepId: string;
  name: string;
  json: boolean;
  referencedCrossJob: boolean;
}

type ParsedSource =
  | { kind: "value"; value: string; required: boolean; json: boolean; type: ParamType; raw: string }
  | { kind: "capture"; body: string; json: boolean; type: ParamType; raw: string };

function paramType(value: unknown): ParamType {
  return typeof value === "string" && PARAM_TYPES.has(value) ? (value as ParamType) : "string";
}

function parseSource(source: unknown): ParsedSource | null {
  if (typeof source === "string") {
    return {
      kind: "value",
      value: source,
      required: false,
      json: false,
      type: "string",
      raw: source,
    };
  }
  if (typeof source === "number" || typeof source === "boolean") {
    const value = String(source);
    return { kind: "value", value, required: false, json: false, type: "string", raw: value };
  }
  if (isObject(source)) {
    const type = paramType(source.type);
    const json = Boolean(source.json);
    if (typeof source.run === "string") {
      return { kind: "capture", body: source.run, json, type, raw: source.run };
    }
    if (source.value !== undefined) {
      const value = String(source.value);
      return { kind: "value", value, required: Boolean(source.required), json, type, raw: value };
    }
  }
  return null;
}

// --- consumer rewriting -----------------------------------------------------

const isIdentStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
const isSegPart = (ch: string): boolean => /[A-Za-z0-9_-]/.test(ch);

/** Find the index of the closing `}}`, respecting GitHub-expression string literals. */
function findExprClose(s: string, from: number): number {
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

interface ScanState {
  ctx: ParseContext;
  registry: Map<string, Producer[]>;
  jobIds: ReadonlySet<string>;
  edges: Map<string, Set<string>>;
  path: Path;
}

/** Resolve a `share.<segments>` reference to its lowered runtime expression. */
function resolveShare(segments: string[], consumerJobId: string, state: ScanState): string {
  const original = `share.${segments.join(".")}`;
  if (segments.length === 0) {
    pushDiagnostic(state.ctx, "error", "empty share reference", state.path, {
      code: "share-unknown",
    });
    return "share";
  }

  let producer: Producer | undefined;
  let name = "";
  let dots: string[] = [];

  const first = segments[0];
  const second = segments[1];
  if (
    segments.length >= 2 &&
    first !== undefined &&
    second !== undefined &&
    state.jobIds.has(first)
  ) {
    const qualified = (state.registry.get(second) ?? []).find((p) => p.jobId === first);
    if (qualified) {
      producer = qualified;
      name = second;
      dots = segments.slice(2);
    }
  }

  if (!producer) {
    name = first ?? "";
    dots = segments.slice(1);
    const candidates = state.registry.get(name) ?? [];
    if (candidates.length === 0) {
      pushDiagnostic(state.ctx, "error", `unknown shared value "${name}"`, state.path, {
        code: "share-unknown",
      });
      return original;
    }
    if (candidates.length > 1) {
      const owners = candidates.map((p) => p.jobId).join(", ");
      pushDiagnostic(
        state.ctx,
        "error",
        `ambiguous share reference "${name}" produced by jobs: ${owners}; qualify it as \${{ share.<job>.${name} }}`,
        state.path,
        { code: "share-ambiguous" },
      );
      return original;
    }
    const only = candidates[0];
    if (!only) return original;
    producer = only;
  }

  if (dots.length > 0 && !producer.json) {
    pushDiagnostic(
      state.ctx,
      "error",
      `dotted reference "${original}" requires the shared value to be declared json: true`,
      state.path,
      { code: "share-not-json" },
    );
    return original;
  }

  const sameJob = producer.jobId === consumerJobId;
  const base = sameJob
    ? `steps.${producer.stepId}.outputs.${name}`
    : `needs.${producer.jobId}.outputs.${name}`;

  if (!sameJob) {
    producer.referencedCrossJob = true;
    let set = state.edges.get(consumerJobId);
    if (!set) {
      set = new Set();
      state.edges.set(consumerJobId, set);
    }
    set.add(producer.jobId);
  }

  return dots.length > 0 ? `fromJSON(${base}).${dots.join(".")}` : base;
}

/** Rewrite `share.*` identifiers inside one `${{ ... }}` expression body. */
function rewriteExprBody(body: string, consumerJobId: string, state: ScanState): string {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < body.length) {
    const ch = body[i] ?? "";
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (body[i + 1] === quote) {
          out += body[i + 1];
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
      out += ch;
      i++;
      continue;
    }
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < body.length && isIdentPart(body[end] ?? "")) end++;
      const ident = body.slice(i, end);
      let p = i - 1;
      while (p >= 0 && (body[p] === " " || body[p] === "\t")) p--;
      const precededByDot = p >= 0 && body[p] === ".";
      if (ident === "share" && !precededByDot) {
        let j = end;
        const segments: string[] = [];
        while (body[j] === ".") {
          const s = j + 1;
          let e = s;
          while (e < body.length && isSegPart(body[e] ?? "")) e++;
          if (e === s) break;
          segments.push(body.slice(s, e));
          j = e;
        }
        out += resolveShare(segments, consumerJobId, state);
        i = j;
        continue;
      }
      out += ident;
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Rewrite all `${{ share.* }}` references in a string, honoring `$${{ ... }}` escapes. */
function rewriteShareRefs(value: string, consumerJobId: string, state: ScanState): string {
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
    out += `\${{${rewriteExprBody(inner, consumerJobId, state)}}}`;
    cursor = close + 2;
  }
  return out;
}

function walkStrings(node: unknown, fn: (s: string) => string): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === "string") node[i] = fn(v);
      else walkStrings(v, fn);
    }
  } else if (isObject(node)) {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === "string") node[k] = fn(v);
      else walkStrings(v, fn);
    }
  }
}

// --- collection -------------------------------------------------------------

function collectJob(
  ctx: ParseContext,
  jobId: string,
  job: Job,
  registry: Map<string, Producer[]>,
): void {
  if (job.share != null) {
    pushDiagnostic(
      ctx,
      "warning",
      `share must be declared on a step, not on job "${jobId}"; ignoring`,
      ["jobs", jobId, "share"],
      { code: "share-not-on-step" },
    );
    delete job.share;
  }

  if (!Array.isArray(job.steps)) return;
  const isMatrix = isObject(job.strategy) && job.strategy.matrix !== undefined;
  const used = collectUsedStepIds(job.steps);
  const seenNames = new Set<string>();

  job.steps.forEach((step, idx) => {
    if (!isObject(step) || step.share == null) return;
    const sharePath: Path = ["jobs", jobId, "steps", idx, "share"];
    if (
      !expectMapping(ctx, step.share, sharePath, {
        message: "share must be a mapping of <name> to a value or { run } block",
        code: "share-name-invalid",
      })
    ) {
      delete step.share;
      return;
    }

    const writers: string[] = [];
    let stepId: string | undefined;

    for (const [rawName, source] of Object.entries(step.share)) {
      if (!NAME_RE.test(rawName)) {
        pushDiagnostic(
          ctx,
          "error",
          `invalid share output name "${rawName}"`,
          [...sharePath, rawName],
          {
            code: "share-name-invalid",
          },
        );
        continue;
      }
      if (seenNames.has(rawName)) {
        pushDiagnostic(
          ctx,
          "error",
          `duplicate share output "${rawName}" in job "${jobId}"`,
          [...sharePath, rawName],
          { code: "share-duplicate" },
        );
        continue;
      }
      const spec = parseSource(source);
      if (!spec) {
        pushDiagnostic(
          ctx,
          "warning",
          `share output "${rawName}" must be a scalar, { value } or { run } block; ignoring`,
          [...sharePath, rawName],
          { code: "share-name-invalid" },
        );
        continue;
      }

      const fromSecret = spec.raw.includes("secrets.");
      if (fromSecret) {
        pushDiagnostic(
          ctx,
          "warning",
          `share output "${rawName}" derives from a secret; it will be written to job outputs in cleartext`,
          [...sharePath, rawName],
          { code: "share-secret" },
        );
      }
      if (isMatrix) {
        pushDiagnostic(
          ctx,
          "warning",
          `share output "${rawName}" is produced by matrix job "${jobId}"; concurrent matrix legs race on the same output`,
          [...sharePath, rawName],
          { code: "share-matrix-race" },
        );
      }

      seenNames.add(rawName);
      if (!stepId) {
        stepId = ensureStepId(
          step,
          used,
          `step_${slugify(rawName)}` || `actio_${jobId}_step_${idx + 1}`,
        );
      }

      if (spec.kind === "value") {
        writers.push(
          buildOutputWriter({
            kind: "value",
            name: rawName,
            value: spec.value,
            required: spec.required,
          }),
        );
      } else {
        const delimiter = `ACTIO_EOF_${rawName}_${fnv1a(`${jobId}:${stepId}:${rawName}`)}`;
        writers.push(
          buildOutputWriter({ kind: "capture", name: rawName, body: spec.body, delimiter }),
        );
      }

      const list = registry.get(rawName) ?? [];
      list.push({ jobId, job, stepId, name: rawName, json: spec.json, referencedCrossJob: false });
      registry.set(rawName, list);

      ctx.symbols.set(`share:${jobId}:${rawName}`, {
        name: rawName,
        kind: "shared-output",
        type: spec.type,
        compileTimeKnown: false,
        taint: { tainted: fromSecret, derivedFrom: fromSecret ? ["secrets"] : [] },
      });
    }

    delete step.share;
    if (writers.length > 0) {
      const existing = typeof step.run === "string" && step.run.length > 0 ? step.run : "";
      step.run = existing ? `${existing}\n${writers.join("\n")}` : writers.join("\n");
    }
  });
}

// --- wiring -----------------------------------------------------------------

function hasNeedsCycle(jobs: Record<string, Job>): boolean {
  const adj = new Map<string, string[]>();
  for (const [id, job] of Object.entries(jobs)) {
    const needs =
      typeof job.needs === "string" ? [job.needs] : Array.isArray(job.needs) ? job.needs : [];
    adj.set(
      id,
      needs.filter((n): n is string => typeof n === "string"),
    );
  }
  const color = new Map<string, number>();
  const dfs = (n: string): boolean => {
    color.set(n, 1);
    for (const m of adj.get(n) ?? []) {
      const c = color.get(m) ?? 0;
      if (c === 1) return true;
      if (c === 0 && dfs(m)) return true;
    }
    color.set(n, 2);
    return false;
  };
  for (const id of adj.keys()) {
    if ((color.get(id) ?? 0) === 0 && dfs(id)) return true;
  }
  return false;
}

/**
 * share pass: lowers `share:` producers on steps into `$GITHUB_OUTPUT` writers,
 * rewrites `${{ share.* }}` consumers to `steps`/`needs` expressions, and infers
 * the `needs` edges + `job.outputs` wiring that makes cross-job sharing work.
 *
 * TODO(share-foreach-integration): consume forEach's per-iteration share
 * contracts so a `for_each` producer fans its outputs into sibling jobs.
 */
export function sharePass(ctx: ParseContext): void {
  const registry = new Map<string, Producer[]>();

  // Phase 1 — COLLECT producers and append their output writers.
  visitJobs(ctx, ({ id, job }) => {
    if (job.for_each != null) return; // defensive: leave for_each jobs to that pass
    collectJob(ctx, id, job, registry);
  });

  // Phase 2 — SCAN + REWRITE consumers (needs a global producer view).
  const jobs = workflow(ctx).jobs ?? {};
  const jobIds = new Set(Object.keys(jobs));
  const edges = new Map<string, Set<string>>();
  visitJobs(ctx, ({ id, job }) => {
    const state: ScanState = { ctx, registry, jobIds, edges, path: ["jobs", id] };
    walkStrings(job, (s) => rewriteShareRefs(s, id, state));
  });

  // Phase 3 — WIRE job.outputs for cross-job producers and infer needs.
  for (const list of registry.values()) {
    for (const p of list) {
      if (!p.referencedCrossJob) continue;
      if (!isObject(p.job.outputs)) p.job.outputs = {};
      p.job.outputs[p.name] = `\${{ steps.${p.stepId}.outputs.${p.name} }}`;
    }
  }
  for (const [consumerJobId, producers] of edges) {
    const job = jobs[consumerJobId];
    if (!job) continue;
    job.needs = mergeNeeds(job.needs, [...producers]);
  }

  if (edges.size > 0 && hasNeedsCycle(jobs)) {
    pushDiagnostic(
      ctx,
      "error",
      "share inference introduced a needs cycle between jobs",
      ["jobs"],
      {
        code: "share-cycle",
      },
    );
  }
}

export const share: Pass = {
  name: "share",
  runsAfter: ["fragments"],
  apply: sharePass,
};

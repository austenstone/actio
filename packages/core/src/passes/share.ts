import { createHash } from "node:crypto";
import type { Job, Step } from "../ir.js";
import { visitJobs } from "../ir.js";
import { type ParseContext, type Path, setKeyOrder } from "../parser.js";
import { collectExpressionRoots, type ParamType, type SymbolDef } from "../symbols.js";
import {
  collectUsedStepIds,
  ensureStepId,
  expectMapping,
  isObject,
  mergeNeeds,
  pushDiagnostic,
  slugify,
  warnUnknownKeys,
} from "./helpers.js";
import type { Pass } from "./registry.js";

const SHARE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SHARE_OPTION_KEYS: ReadonlySet<string> = new Set([
  "value",
  "run",
  "json",
  "type",
  "required",
]);
const SHARE_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean", "object"]);
// `${{ share.x }}` (or `${{ share.<job>.<name>.<field> }}`) is actio's ONE
// sanctioned `${{ }}` rewrite namespace. A leading `$` (i.e. `$${{ share.x }}`)
// escapes it to a literal token. Distinct from #17's params-runtime-sigil,
// which is a hard error.
const SHARE_TOKEN_RE = /(\$?)\$\{\{\s*share\.([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Where a shared value comes from at runtime. */
export type ShareSource = { kind: "value"; expr: string } | { kind: "capture"; lines: string[] };

interface ProducerDef {
  job: string;
  stepId: string;
  name: string;
  json: boolean;
  required: boolean;
  source: ShareSource;
  crossReferenced: boolean;
}

interface ShareEdge {
  consumer: string;
  producer: string;
  name: string;
}

interface NormalizedShare {
  source: ShareSource;
  json: boolean;
  required: boolean;
  type: ParamType;
}

/** Per-output heredoc delimiter, unique by construction so a captured line that
 * happens to equal a fixed delimiter can never break the heredoc. */
function shareDelimiter(jobId: string, stepId: string, name: string): string {
  const hash = createHash("sha256")
    .update(`${jobId}\u0000${stepId}\u0000${name}`)
    .digest("hex")
    .slice(0, 8);
  return `ACTIO_EOF_${name}_${hash}`;
}

/**
 * Build the `$GITHUB_OUTPUT` writer for one shared output. PURE: it writes
 * whatever `name` it is handed, so the share↔for_each seam can reuse it to emit
 * a per-iteration-named writer (e.g. `version_macos`) without re-deriving any of
 * this logic. Exported for direct unit testing.
 */
export function buildShareWriter(
  name: string,
  jobId: string,
  stepId: string,
  source: ShareSource,
  options?: { required?: boolean },
): string {
  const required = options?.required ?? false;
  if (source.kind === "value") {
    const writer = `echo "${name}=${source.expr}" >> "$GITHUB_OUTPUT"`;
    if (!required) return writer;
    return `${writer}\n[ -n "${source.expr}" ] || { echo "::error::empty share value"; exit 1; }`;
  }
  const delim = shareDelimiter(jobId, stepId, name);
  if (!required) {
    return [
      "{",
      `  echo '${name}<<${delim}'`,
      ...source.lines.map((line) => `  ${line}`),
      `  echo ${delim}`,
      '} >> "$GITHUB_OUTPUT"',
    ].join("\n");
  }
  const varName = `__actio_share_${name.replace(/-/g, "_")}`;
  const capture =
    source.lines.length === 1
      ? `${varName}=$(${source.lines[0] ?? ""})`
      : [`${varName}=$(`, ...source.lines.map((line) => `  ${line}`), ")"].join("\n");
  return [
    capture,
    "{",
    `  echo '${name}<<${delim}'`,
    `  printf '%s\\n' "$${varName}"`,
    `  echo ${delim}`,
    '} >> "$GITHUB_OUTPUT"',
    `[ -n "$${varName}" ] || { echo "::error::empty share value"; exit 1; }`,
  ].join("\n");
}

function splitLines(raw: string): string[] {
  return raw.replace(/\n+$/, "").split("\n");
}

function toScalarSource(raw: string): ShareSource {
  const lines = splitLines(raw);
  if (lines.length <= 1) return { kind: "value", expr: raw.trim() };
  return { kind: "capture", lines };
}

function sourceText(source: ShareSource): string {
  return source.kind === "value" ? source.expr : source.lines.join("\n");
}

function isSecretDerived(source: ShareSource): boolean {
  return collectExpressionRoots(sourceText(source), new Set(["secrets"])).has("secrets");
}

function normalizeShareValue(
  ctx: ParseContext,
  jobId: string,
  name: string,
  raw: unknown,
  path: Path,
): NormalizedShare | undefined {
  if (typeof raw === "string") {
    return { source: toScalarSource(raw), json: false, required: false, type: "string" };
  }
  if (typeof raw === "number") {
    return {
      source: { kind: "value", expr: String(raw) },
      json: false,
      required: false,
      type: "number",
    };
  }
  if (typeof raw === "boolean") {
    return {
      source: { kind: "value", expr: String(raw) },
      json: false,
      required: false,
      type: "boolean",
    };
  }
  if (
    !expectMapping(ctx, raw, path, {
      message: `Job "${jobId}": share output "${name}" must be a string or a mapping`,
      code: "share/invalid-value",
    })
  ) {
    return undefined;
  }
  warnUnknownKeys(ctx, raw, SHARE_OPTION_KEYS, path, {
    severity: "warning",
    message: (key) => `Job "${jobId}": unknown share option "${key}" on "${name}"`,
    code: "share/unknown-option",
  });
  const json = raw.json === true;
  const required = raw.required === true;
  // Boolean asymmetry (LOCKED): a `type: boolean` shared-output is a
  // compile-time TYPE assertion only. Unlike #17's boolean *param* (which
  // injects `fromJSON(inputs.x) == true`), share injects NO runtime coercion:
  // job outputs are already typed and the GHA primitives diverge. So `type` is
  // recorded on the symbol but never changes the emitted writer.
  let type: ParamType = json ? "object" : "string";
  if (typeof raw.type === "string" && SHARE_TYPES.has(raw.type)) {
    type = raw.type as ParamType;
  }
  if (typeof raw.value === "string") {
    return { source: toScalarSource(raw.value), json, required, type };
  }
  if (typeof raw.run === "string") {
    return { source: { kind: "capture", lines: splitLines(raw.run) }, json, required, type };
  }
  pushDiagnostic(
    ctx,
    "error",
    `Job "${jobId}": share output "${name}" needs "value:" or "run:"`,
    path,
    {
      code: "share/missing-source",
    },
  );
  return undefined;
}

function registerSymbol(
  ctx: ParseContext,
  name: string,
  type: ParamType,
  required: boolean,
  secretDerived: boolean,
): void {
  const def: SymbolDef = {
    name,
    kind: "shared-output",
    type,
    // The runtime VALUE is unknown at compile time (only the TYPE is known).
    compileTimeKnown: false,
    required,
    taint: { tainted: secretDerived, derivedFrom: secretDerived ? ["secrets"] : [] },
  };
  ctx.symbols.set(name, def);
}

function isMatrixJob(job: Job): boolean {
  if (job.dynamic_matrix !== undefined) return true;
  return isObject(job.strategy) && job.strategy.matrix !== undefined;
}

/** Producer step keys settle to `name, id, run, …` (issue §3.1). */
function reorderStepKeys(step: Step): void {
  const keys = Object.keys(step);
  const front = ["name", "id", "run"].filter((key) => keys.includes(key));
  const rest = keys.filter((key) => !front.includes(key));
  setKeyOrder(step, [...front, ...rest]);
}

/** Touched jobs settle to `…, needs, outputs, steps` (issue §3). */
function reorderJobKeys(job: Job): void {
  const keys = Object.keys(job);
  const order = keys.filter((key) => key !== "needs" && key !== "outputs" && key !== "steps");
  if (keys.includes("needs")) order.push("needs");
  if (keys.includes("outputs")) order.push("outputs");
  if (keys.includes("steps")) order.push("steps");
  setKeyOrder(job, order);
}

/** Phase 1 — COLLECT: register producers, append writers, strip `share:`. */
function collectJobProducers(
  ctx: ParseContext,
  jobId: string,
  job: Job,
  producers: Map<string, ProducerDef[]>,
): void {
  if (job.share != null) {
    pushDiagnostic(
      ctx,
      "warning",
      `Job "${jobId}": share is only supported on steps; ignoring`,
      ["jobs", jobId, "share"],
      { code: "share/on-job" },
    );
    delete job.share;
  }
  const steps = job.steps;
  if (!Array.isArray(steps)) return;

  const used = collectUsedStepIds(steps);
  const seenInJob = new Set<string>();
  let jobProduced = false;

  steps.forEach((step, index) => {
    if (!isObject(step) || step.share == null) return;
    const sharePath: Path = ["jobs", jobId, "steps", index, "share"];
    if (
      !expectMapping(ctx, step.share, sharePath, {
        message: `Job "${jobId}": share must be a mapping of name to value`,
        code: "share/invalid",
      })
    ) {
      delete step.share;
      return;
    }
    const entries = Object.entries(step.share);
    const writers: string[] = [];
    let stepId: string | undefined;

    for (const [name, rawVal] of entries) {
      const entryPath: Path = [...sharePath, name];
      if (!SHARE_NAME_RE.test(name)) {
        pushDiagnostic(
          ctx,
          "error",
          `Job "${jobId}": share output name "${name}" is invalid; use letters, digits, _ or -`,
          entryPath,
          { code: "share/invalid-name" },
        );
        continue;
      }
      if (seenInJob.has(name)) {
        pushDiagnostic(
          ctx,
          "error",
          `Job "${jobId}": share output "${name}" declared twice`,
          entryPath,
          {
            code: "share/duplicate",
          },
        );
        continue;
      }
      const normalized = normalizeShareValue(ctx, jobId, name, rawVal, entryPath);
      if (!normalized) continue;
      seenInJob.add(name);

      if (stepId === undefined) {
        stepId = ensureStepId(step, used, `step_${slugify(name)}`);
      }
      if (isSecretDerived(normalized.source)) {
        pushDiagnostic(
          ctx,
          "warning",
          `Sharing a value derived from a secret may expose it via job outputs`,
          entryPath,
          { code: "share/secret" },
        );
      }
      const list = producers.get(name) ?? [];
      list.push({
        job: jobId,
        stepId,
        name,
        json: normalized.json,
        required: normalized.required,
        source: normalized.source,
        crossReferenced: false,
      });
      producers.set(name, list);
      registerSymbol(
        ctx,
        name,
        normalized.type,
        normalized.required,
        isSecretDerived(normalized.source),
      );
      writers.push(
        buildShareWriter(name, jobId, stepId, normalized.source, { required: normalized.required }),
      );
      jobProduced = true;
    }

    if (writers.length > 0) {
      const existing = typeof step.run === "string" && step.run.length > 0 ? `${step.run}\n` : "";
      step.run = existing + writers.join("\n");
      delete step.share;
      reorderStepKeys(step);
    } else {
      delete step.share;
    }
  });

  if (jobProduced && isMatrixJob(job)) {
    pushDiagnostic(
      ctx,
      "warning",
      `Job "${jobId}": sharing from a matrix job is last-writer-wins; legs may race`,
      ["jobs", jobId],
      { code: "share/matrix" },
    );
  }
}

interface ResolvedRef {
  producer: ProducerDef;
  name: string;
  expr: string;
}

function resolveRef(
  ctx: ParseContext,
  consumerJob: string,
  rawPath: string,
  producers: Map<string, ProducerDef[]>,
  knownJobIds: ReadonlySet<string>,
): ResolvedRef | undefined {
  const segs = rawPath.split(".");
  const head = segs[0] ?? "";
  const second = segs[1] ?? "";
  let qualifiedJob: string | undefined;
  let name: string;
  let dots: string[];
  const headIsJob =
    segs.length >= 2 &&
    knownJobIds.has(head) &&
    (producers.get(second) ?? []).some((p) => p.job === head);
  if (headIsJob) {
    qualifiedJob = head;
    name = second;
    dots = segs.slice(2);
  } else {
    name = head;
    dots = segs.slice(1);
  }

  let candidates = producers.get(name) ?? [];
  if (qualifiedJob) candidates = candidates.filter((p) => p.job === qualifiedJob);

  if (candidates.length === 0) {
    const available = [...producers.keys()].sort().join(", ") || "none";
    pushDiagnostic(
      ctx,
      "error",
      `Unknown shared value "${name}"; declare it with share: on a step (available: ${available})`,
      ["jobs", consumerJob],
      { code: "share/unknown" },
    );
    return undefined;
  }
  if (candidates.length > 1) {
    const jobsList = candidates.map((p) => p.job).join(", ");
    pushDiagnostic(
      ctx,
      "error",
      `Ambiguous shared value "${name}" (produced by ${jobsList}); qualify it as \${{ share.<job>.${name} }}`,
      ["jobs", consumerJob],
      { code: "share/ambiguous" },
    );
    return undefined;
  }
  const producer = candidates[0];
  if (!producer) return undefined;
  if (dots.length > 0 && !producer.json) {
    pushDiagnostic(
      ctx,
      "error",
      `Shared value "${name}" is not JSON; add "json: true" to use \${{ share.${name}.${dots.join(".")} }}`,
      ["jobs", consumerJob],
      { code: "share/not-json" },
    );
    return undefined;
  }
  const base =
    producer.job === consumerJob
      ? `steps.${producer.stepId}.outputs.${name}`
      : `needs.${producer.job}.outputs.${name}`;
  const expr = dots.length > 0 ? `fromJSON(${base}).${dots.join(".")}` : base;
  return { producer, name, expr };
}

function rewriteShareTokens(
  ctx: ParseContext,
  consumerJob: string,
  input: string,
  producers: Map<string, ProducerDef[]>,
  knownJobIds: ReadonlySet<string>,
  edges: ShareEdge[],
): string {
  return input.replace(SHARE_TOKEN_RE, (full, esc: string, path: string) => {
    if (esc === "$") return `\${{ share.${path} }}`;
    const resolved = resolveRef(ctx, consumerJob, path, producers, knownJobIds);
    if (!resolved) return full;
    if (resolved.producer.job !== consumerJob) {
      resolved.producer.crossReferenced = true;
      edges.push({ consumer: consumerJob, producer: resolved.producer.job, name: resolved.name });
    }
    return `\${{ ${resolved.expr} }}`;
  });
}

function walkStrings(node: unknown, replace: (value: string) => string): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const value = node[i];
      if (typeof value === "string") node[i] = replace(value);
      else if (value && typeof value === "object") walkStrings(value, replace);
    }
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (typeof value === "string") obj[key] = replace(value);
      else if (value && typeof value === "object") walkStrings(value, replace);
    }
  }
}

function needsList(needs: unknown): string[] {
  if (typeof needs === "string") return [needs];
  if (Array.isArray(needs)) return needs.filter((n): n is string => typeof n === "string");
  return [];
}

function findCycle(graph: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let result: string[] | undefined;
  const dfs = (node: string): boolean => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      const st = state.get(next) ?? 0;
      if (st === 1) {
        const idx = stack.indexOf(next);
        result = [...stack.slice(idx), next];
        return true;
      }
      if (st === 0 && dfs(next)) return true;
    }
    stack.pop();
    state.set(node, 2);
    return false;
  };
  for (const node of graph.keys()) {
    if ((state.get(node) ?? 0) === 0 && dfs(node)) break;
  }
  return result;
}

function detectShareCycle(ctx: ParseContext, jobMap: Map<string, Job>, edges: ShareEdge[]): void {
  const graph = new Map<string, string[]>();
  for (const [id, job] of jobMap) graph.set(id, needsList(job.needs));
  const cycle = findCycle(graph);
  if (!cycle) return;
  const inferred = new Map<string, string>();
  for (const edge of edges) inferred.set(`${edge.consumer}->${edge.producer}`, edge.name);
  let name: string | undefined;
  for (let i = 0; i < cycle.length - 1; i++) {
    const candidate = inferred.get(`${cycle[i] ?? ""}->${cycle[i + 1] ?? ""}`);
    if (candidate) {
      name = candidate;
      break;
    }
  }
  if (!name) return;
  pushDiagnostic(
    ctx,
    "error",
    `Sharing "${name}" creates a needs cycle: ${cycle.join(" → ")}`,
    ["jobs", cycle[0] ?? ""],
    { code: "share/cycle" },
  );
}

/** Phase 3 — WIRE: hoist cross-job outputs, infer needs, assert acyclic. */
function wire(
  ctx: ParseContext,
  jobs: { id: string; job: Job }[],
  producers: Map<string, ProducerDef[]>,
  edges: ShareEdge[],
): void {
  const jobMap = new Map(jobs.map((entry) => [entry.id, entry.job]));
  const touched = new Set<string>();

  for (const list of producers.values()) {
    for (const producer of list) {
      if (!producer.crossReferenced) continue;
      const job = jobMap.get(producer.job);
      if (!job) continue;
      const outputs = isObject(job.outputs) ? job.outputs : {};
      outputs[producer.name] = `\${{ steps.${producer.stepId}.outputs.${producer.name} }}`;
      job.outputs = outputs;
      touched.add(producer.job);
    }
  }

  const byConsumer = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.consumer === edge.producer) continue;
    const set = byConsumer.get(edge.consumer) ?? new Set<string>();
    set.add(edge.producer);
    byConsumer.set(edge.consumer, set);
  }
  for (const [consumer, prods] of byConsumer) {
    const job = jobMap.get(consumer);
    if (!job) continue;
    job.needs = mergeNeeds(job.needs, [...prods]);
    touched.add(consumer);
  }

  detectShareCycle(ctx, jobMap, edges);

  for (const { id, job } of jobs) {
    if (touched.has(id)) reorderJobKeys(job);
  }
}

export function sharePass(ctx: ParseContext): void {
  const jobs: { id: string; job: Job }[] = [];
  visitJobs(ctx, (view) => jobs.push({ id: view.id, job: view.job }));
  const knownJobIds = new Set(jobs.map((entry) => entry.id));
  const producers = new Map<string, ProducerDef[]>();

  for (const { id, job } of jobs) collectJobProducers(ctx, id, job, producers);

  const edges: ShareEdge[] = [];
  for (const { id, job } of jobs) {
    walkStrings(job, (value) => rewriteShareTokens(ctx, id, value, producers, knownJobIds, edges));
  }

  wire(ctx, jobs, producers, edges);
}

/**
 * share pass: collapses GHA's four-point cross-job output wiring (GITHUB_OUTPUT
 * write + step id + job-level outputs + consumer needs/reads) into one `share:`
 * producer block plus name-only `${{ share.x }}` references with inferred needs.
 *
 * Runs AFTER `fragments` so it sees fully-expanded steps; `retry`, `fallback`
 * and `dynamic_matrix` are ordered after it (via their own `runsAfter`) so the
 * producer's writer is in place before they clone or fan out the step.
 *
 * TODO(share-foreach-integration): the live share-in-for_each golden (per-key
 * output naming) is the joint seam owned by whichever of #18/#20 merges second.
 * The per-iteration-name writer primitive (`buildShareWriter`) is unit-tested
 * here; the for_each wiring lands with that seam.
 */
export const share: Pass = { name: "share", runsAfter: ["fragments"], apply: sharePass };

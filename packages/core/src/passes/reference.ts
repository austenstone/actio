import { type Job, visitJobs, workflow } from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import {
  collectUsedStepIds,
  ensureStepId,
  isObject,
  mergeNeeds,
  pushDiagnostic,
  slugify,
} from "./helpers.js";
import {
  detectCycle,
  isIdentPart,
  isIdentStart,
  isSegPart,
  reportMatrixOutputClobber,
  scanRuntimeExprs,
  walkStrings,
} from "./referenceGraph.js";
import type { Pass } from "./registry.js";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * A reference producer: a step that exposes one or more named `outputs` under a
 * logical `handle`. Kind splits the output-validation policy: an `action`
 * producer (`uses:`) cannot have its outputs statically verified, so an unknown
 * output is a warning; a `run` producer declares the exact set it writes, so an
 * unknown output is a hard error.
 */
interface RefProducer {
  jobId: string;
  job: Job;
  stepId: string;
  handle: string;
  outputs: Set<string>;
  kind: "action" | "run";
  path: Path;
}

interface ScanState {
  ctx: ParseContext;
  byHandle: Map<string, RefProducer[]>;
  jobs: Record<string, Job>;
  synth: Map<string, { jobId: string; job: Job; stepId: string; name: string; path: Path }>;
  edges: [string, string][];
}

function readOutputs(ctx: ParseContext, raw: unknown, path: Path): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !NAME_RE.test(item)) {
      pushDiagnostic(ctx, "error", `invalid ref output name "${String(item)}"`, path, {
        code: "ref-unknown-output",
      });
      continue;
    }
    out.push(item);
  }
  return out;
}

// --- collection -------------------------------------------------------------

function collectJob(
  ctx: ParseContext,
  jobId: string,
  job: Job,
  byHandle: Map<string, RefProducer[]>,
): void {
  if (job.ref != null) {
    pushDiagnostic(
      ctx,
      "warning",
      `ref must be declared on a step, not on job "${jobId}"; ignoring`,
      ["jobs", jobId, "ref"],
      { code: "ref-output-undeclared" },
    );
    delete job.ref;
  }

  if (!Array.isArray(job.steps)) return;
  const used = collectUsedStepIds(job.steps);

  job.steps.forEach((step, idx) => {
    if (!isObject(step) || step.ref == null) return;
    const refPath: Path = ["jobs", jobId, "steps", idx, "ref"];
    const block = step.ref;
    if (!isObject(block)) {
      pushDiagnostic(ctx, "error", "ref must be a mapping of { handle?, outputs }", refPath, {
        code: "ref-output-undeclared",
      });
      delete step.ref;
      return;
    }

    const outputs = readOutputs(ctx, block.outputs, [...refPath, "outputs"]) ?? [];
    if (outputs.length === 0) {
      pushDiagnostic(
        ctx,
        "error",
        `ref producer in job "${jobId}" must declare a non-empty outputs: [..]`,
        refPath,
        { code: "ref-output-undeclared" },
      );
      delete step.ref;
      return;
    }

    const kind: "action" | "run" = typeof step.uses === "string" ? "action" : "run";
    const stepId = ensureStepId(step, used, `ref_${jobId}_step_${idx + 1}`);
    const explicit = typeof block.handle === "string" ? block.handle : undefined;
    const derived = typeof step.name === "string" && step.name ? slugify(step.name) : stepId;
    const handle = explicit && explicit.length > 0 ? explicit : derived;

    const peers = byHandle.get(handle) ?? [];
    if (peers.some((p) => p.jobId === jobId)) {
      pushDiagnostic(
        ctx,
        "error",
        `ambiguous ref handle "${handle}" declared twice in job "${jobId}"; set a distinct handle:`,
        refPath,
        { code: "ref-ambiguous" },
      );
      delete step.ref;
      return;
    }

    peers.push({ jobId, job, stepId, handle, outputs: new Set(outputs), kind, path: refPath });
    byHandle.set(handle, peers);
    delete step.ref;
  });
}

// --- consumer resolution ----------------------------------------------------

function markCrossJob(
  producer: RefProducer,
  consumerJobId: string,
  name: string,
  state: ScanState,
) {
  state.edges.push([consumerJobId, producer.jobId]);
  const key = `${producer.jobId}\u0000${name}`;
  if (!state.synth.has(key)) {
    state.synth.set(key, {
      jobId: producer.jobId,
      job: producer.job,
      stepId: producer.stepId,
      name,
      path: producer.path,
    });
  }
}

function resolveRef(
  segments: string[],
  consumerJobId: string,
  consumerStepId: string | undefined,
  path: Path,
  state: ScanState,
): string {
  const original = `ref.${segments.join(".")}`;

  // ref.job.<callId>.<output> -> a reusable call-job's native output (needs edge only).
  if (segments[0] === "job") {
    const callId = segments[1] ?? "";
    const name = segments[2] ?? "";
    const dots = segments.slice(3);
    const call = state.jobs[callId];
    if (!call || typeof call.uses !== "string" || !name) {
      pushDiagnostic(state.ctx, "error", `unknown ref call-job "${callId}"`, path, {
        code: "ref-unknown-step",
      });
      return original;
    }
    state.edges.push([consumerJobId, callId]);
    const base = `needs.${callId}.outputs.${name}`;
    return dots.length > 0 ? `fromJSON(${base}).${dots.join(".")}` : base;
  }

  let producer: RefProducer | undefined;
  let name = "";
  let dots: string[] = [];

  // Qualified ref.<job>.<handle>.<output>.
  const first = segments[0];
  if (segments.length >= 3 && first !== undefined && state.jobs[first]) {
    const handle = segments[1] ?? "";
    const qualified = (state.byHandle.get(handle) ?? []).find((p) => p.jobId === first);
    if (qualified) {
      producer = qualified;
      name = segments[2] ?? "";
      dots = segments.slice(3);
    }
  }

  // Unqualified ref.<handle>.<output>.
  if (!producer) {
    const handle = first ?? "";
    name = segments[1] ?? "";
    dots = segments.slice(2);
    const candidates = state.byHandle.get(handle) ?? [];
    if (candidates.length === 0) {
      pushDiagnostic(state.ctx, "error", `unknown ref handle "${handle}"`, path, {
        code: "ref-unknown-step",
      });
      return original;
    }
    if (candidates.length > 1) {
      const owners = candidates.map((p) => p.jobId).join(", ");
      pushDiagnostic(
        state.ctx,
        "error",
        `ambiguous ref handle "${handle}" produced by jobs: ${owners}; qualify it as \${{ ref.<job>.${handle}.<output> }}`,
        path,
        { code: "ref-ambiguous" },
      );
      return original;
    }
    producer = candidates[0];
  }

  if (!producer || !name) return original;

  if (producer.stepId === consumerStepId && producer.jobId === consumerJobId) {
    pushDiagnostic(
      state.ctx,
      "error",
      `ref handle "${producer.handle}" references its own step`,
      path,
      { code: "ref-self" },
    );
    return original;
  }

  if (!producer.outputs.has(name)) {
    if (producer.kind === "action") {
      pushDiagnostic(
        state.ctx,
        "warning",
        `ref output "${name}" is not in the declared outputs of action handle "${producer.handle}"; wiring it anyway`,
        path,
        { code: "ref-output-unknown-on-action" },
      );
    } else {
      pushDiagnostic(
        state.ctx,
        "error",
        `ref output "${name}" is not declared on handle "${producer.handle}"`,
        path,
        { code: "ref-unknown-output" },
      );
      return original;
    }
  }

  const sameJob = producer.jobId === consumerJobId;
  const base = sameJob
    ? `steps.${producer.stepId}.outputs.${name}`
    : `needs.${producer.jobId}.outputs.${name}`;
  if (!sameJob) markCrossJob(producer, consumerJobId, name, state);
  return dots.length > 0 ? `fromJSON(${base}).${dots.join(".")}` : base;
}

/** Rewrite `ref.*` identifiers inside one `${{ ... }}` expression body. */
function rewriteExprBody(
  body: string,
  consumerJobId: string,
  consumerStepId: string | undefined,
  path: Path,
  state: ScanState,
): string {
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
      if (ident === "ref" && !precededByDot) {
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
        out += resolveRef(segments, consumerJobId, consumerStepId, path, state);
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

function rewriteJob(jobId: string, job: Job, state: ScanState): void {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const key of Object.keys(job)) {
    if (key === "steps") continue;
    const path: Path = ["jobs", jobId, key];
    const v = (job as Record<string, unknown>)[key];
    const rewrite = (s: string) =>
      scanRuntimeExprs(s, (inner) => rewriteExprBody(inner, jobId, undefined, path, state));
    if (typeof v === "string") (job as Record<string, unknown>)[key] = rewrite(v);
    else walkStrings(v, rewrite);
  }
  steps.forEach((step, idx) => {
    if (!isObject(step)) return;
    const stepId = typeof step.id === "string" ? step.id : undefined;
    const path: Path = ["jobs", jobId, "steps", idx];
    const rewrite = (s: string) =>
      scanRuntimeExprs(s, (inner) => rewriteExprBody(inner, jobId, stepId, path, state));
    walkStrings(step, rewrite);
  });
}

// --- passes -----------------------------------------------------------------

/**
 * reference-lower: collect `ref:` producers, resolve their logical handles,
 * strip the macro keys, and rewrite every `${{ ref.* }}` consumer to its final
 * `steps.*`/`needs.*` expression. Producer-side and resolution-side diagnostics
 * fire here; the cross-job `job.outputs` synthesis and `needs` edges are recorded
 * for `reference-wire` so the matrix-clobber guard sees the final matrix shape.
 */
export function referenceLowerPass(ctx: ParseContext): void {
  const byHandle = new Map<string, RefProducer[]>();
  visitJobs(ctx, ({ id, job }) => collectJob(ctx, id, job, byHandle));

  const jobs = workflow(ctx).jobs ?? {};
  const synth = new Map<
    string,
    { jobId: string; job: Job; stepId: string; name: string; path: Path }
  >();
  const edges: [string, string][] = [];
  const state: ScanState = { ctx, byHandle, jobs, synth, edges };
  visitJobs(ctx, ({ id, job }) => rewriteJob(id, job, state));

  ctx.internal.referenceGraph = {
    synth: [...synth.values()].map((s) => ({
      jobId: s.jobId,
      job: s.job,
      stepId: s.stepId,
      name: s.name,
      path: s.path,
    })),
    edges,
  };
}

export const referenceLower: Pass = {
  name: "reference-lower",
  runsAfter: ["fragments", "share"],
  apply: referenceLowerPass,
};

function reportRefMatrixClobber(ctx: ParseContext, jobId: string, name: string, path: Path): void {
  reportMatrixOutputClobber(ctx, {
    jobId,
    name,
    path,
    code: "ref-matrix-clobber",
    message: `ref output "${name}" escapes matrix job "${jobId}" via job outputs, but GitHub collapses a matrix job's outputs map to a single leg, so only the last leg survives. Reference a non-matrix producer, or fan results in via artifacts.`,
  });
}

/**
 * reference-wire: runs after every matrix/lifecycle pass has settled. For each
 * cross-job step producer it synthesizes `jobs.<id>.outputs.<name>` once (deduped
 * across N consumers), unless the producer's job now carries a matrix, in which
 * case the cross-job reference is a clobber error (#158 analog). It then merges
 * the inferred `needs` edges and flags any reference-induced cycle.
 */
export function referenceWirePass(ctx: ParseContext): void {
  const graph = ctx.internal.referenceGraph;
  if (!graph) return;
  const jobs = workflow(ctx).jobs ?? {};

  for (const { jobId, job, stepId, name, path } of graph.synth) {
    const strategy = job.strategy;
    if (isObject(strategy) && strategy.matrix !== undefined) {
      reportRefMatrixClobber(ctx, jobId, name, path);
      continue;
    }
    if (!isObject(job.outputs)) job.outputs = {};
    const outputs = job.outputs as Record<string, unknown>;
    outputs[name] = `\${{ steps.${stepId}.outputs.${name} }}`;
  }

  const byConsumer = new Map<string, Set<string>>();
  for (const [consumer, producer] of graph.edges) {
    let set = byConsumer.get(consumer);
    if (!set) {
      set = new Set();
      byConsumer.set(consumer, set);
    }
    set.add(producer);
  }
  for (const [consumerJobId, producers] of byConsumer) {
    const job = jobs[consumerJobId];
    if (!job) continue;
    job.needs = mergeNeeds(job.needs, [...producers]);
  }

  if (graph.edges.length > 0) {
    const adj = new Map<string, string[]>();
    for (const [id, job] of Object.entries(jobs)) {
      const needs =
        typeof job.needs === "string" ? [job.needs] : Array.isArray(job.needs) ? job.needs : [];
      adj.set(
        id,
        needs.filter((n): n is string => typeof n === "string"),
      );
    }
    if (detectCycle(adj) !== null) {
      pushDiagnostic(
        ctx,
        "error",
        "ref inference introduced a needs cycle between jobs",
        ["jobs"],
        {
          code: "ref-cycle",
        },
      );
    }
  }
}

export const referenceWire: Pass = {
  name: "reference-wire",
  runsAfter: [
    "dynamic-matrix",
    "expand-matrix",
    "for-each",
    "lifecycle",
    "injection-hoist",
    "share-matrix-check",
  ],
  apply: referenceWirePass,
};

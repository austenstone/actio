import { type Job, type Step, visitJobs, workflow } from "../ir.js";
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
 *
 * `inferred` flips the policy: the producer was synthesized from a consumer's
 * `${{ ref.<handle>.<output> }}` reference rather than declared with `ref:`. An
 * inferred run producer carries a static `scan` of its `$GITHUB_OUTPUT` writes;
 * an inferred action producer accumulates outputs straight from references.
 */
interface RefProducer {
  jobId: string;
  job: Job;
  stepId: string;
  handle: string;
  outputs: Set<string>;
  kind: "action" | "run";
  path: Path;
  inferred?: boolean;
  scan?: RunScan;
  warnedDynamic?: boolean;
}

/**
 * The result of statically scanning a `run:` script for `$GITHUB_OUTPUT` writes.
 * `outputs` is the set of statically resolvable output names; `isStatic` is true
 * only when every write was parseable, which makes the set authoritative.
 */
interface RunScan {
  outputs: Set<string>;
  isStatic: boolean;
}

interface ScanState {
  ctx: ParseContext;
  byHandle: Map<string, RefProducer[]>;
  jobs: Record<string, Job>;
  synth: Map<string, { jobId: string; job: Job; stepId: string; name: string; path: Path }>;
  edges: [string, string][];
  attempted: Set<string>;
  usedByJob: Map<string, Set<string>>;
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

// --- run-script $GITHUB_OUTPUT scanner --------------------------------------

// Matches a `$GITHUB_OUTPUT` reference in any of its common spellings:
// $GITHUB_OUTPUT, ${GITHUB_OUTPUT}, "$GITHUB_OUTPUT", "${GITHUB_OUTPUT}".
const GH_OUTPUT = String.raw`"?\$\{?GITHUB_OUTPUT\}?"?`;
// True when a line contains any redirect (`>` or `>>`) into $GITHUB_OUTPUT.
const GH_WRITE = new RegExp(String.raw`>>?\s*${GH_OUTPUT}`);
// True only when that redirect sits at the end of the line (optionally followed
// by a trailing comment). A write that is not line-final is something we cannot
// confidently dissect, so it forces a degrade to non-static.
const GH_WRITE_TAIL = new RegExp(String.raw`>>?\s*${GH_OUTPUT}\s*(?:#.*)?$`);
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_-]*)=/;
// GitHub's multiline output opener echoed into the file: `name<<DELIM`.
const HEREDOC_OPEN_RE = /^([A-Za-z_][A-Za-z0-9_-]*)<<-?\s*['"]?(\w+)['"]?$/;

/** Unwrap one layer of matching quotes, else return the first whitespace token. */
function firstArg(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '"' || q === "'") && t[t.length - 1] === q) return t.slice(1, -1);
  }
  const m = t.match(/^\S+/);
  return m ? m[0] : "";
}

/** Extract the first argument of an `echo` command, or null if not an echo. */
function echoFirstArg(cmd: string): string | null {
  const segs = cmd.split(/;|&&|\|\|/);
  const last = (segs[segs.length - 1] ?? "").trim();
  const m = last.match(/^echo(?:\s+-[neE]+)*\s+(.*)$/s);
  return m ? firstArg(m[1] ?? "") : null;
}

/**
 * Parse the command portion of a single `$GITHUB_OUTPUT` write (everything left
 * of the redirect). Returns the written output `name`, a multiline `delim`
 * opener, or null when the name cannot be resolved statically (dynamic write).
 */
function parseWrite(cmd: string): { name?: string; delim?: string } | null {
  const segs = cmd.split(/;|&&|\|\|/);
  const last = (segs[segs.length - 1] ?? "").trim();
  const echoM = last.match(/^echo(?:\s+-[neE]+)*\s+(.*)$/s);
  if (echoM) {
    const arg = firstArg(echoM[1] ?? "");
    const hd = arg.match(HEREDOC_OPEN_RE);
    if (hd) return { name: hd[1], delim: hd[2] };
    const as = arg.match(ASSIGN_RE);
    return as ? { name: as[1] } : null;
  }
  const printfM = last.match(/^printf(?:\s+-\S+)*\s+(.*)$/s);
  if (printfM) {
    const as = firstArg(printfM[1] ?? "").match(ASSIGN_RE);
    return as ? { name: as[1] } : null;
  }
  return null;
}

/**
 * Statically scan a `run:` script for the output names it writes to
 * `$GITHUB_OUTPUT`. Handles `echo name=value` (quoted or bare), GitHub's
 * multiline `echo "name<<DELIM"` ... `echo "DELIM"` form, and `printf`.
 *
 * `isStatic` is true only when every write was fully parseable; any dynamic or
 * un-dissectable write degrades the scan to non-authoritative so callers wire
 * the reference with a warning rather than a hard error. The scanner is
 * deliberately conservative: it never claims an output is absent from a script
 * it could not fully parse.
 */
function scanGithubOutputWrites(script: string): RunScan {
  const outputs = new Set<string>();
  let isStatic = true;
  let pendingDelim: string | null = null;

  for (const rawLine of script.split("\n")) {
    const line = rawLine.trim();
    if (!line || !GH_WRITE.test(line)) continue;

    const tail = line.match(GH_WRITE_TAIL);
    if (!tail || tail.index == null) {
      isStatic = false;
      continue;
    }
    const cmd = line.slice(0, tail.index).trim();
    // A second redirect lurking in the command portion means more than one write
    // on this line; we cannot attribute names safely, so degrade.
    if (GH_WRITE.test(cmd)) {
      isStatic = false;
      continue;
    }

    if (pendingDelim != null) {
      if (echoFirstArg(cmd) === pendingDelim) pendingDelim = null;
      continue;
    }

    const parsed = parseWrite(cmd);
    if (parsed == null) {
      isStatic = false;
      continue;
    }
    if (parsed.delim != null && parsed.name != null) {
      outputs.add(parsed.name);
      pendingDelim = parsed.delim;
    } else if (parsed.name != null) {
      outputs.add(parsed.name);
    }
  }

  if (pendingDelim != null) isStatic = false;
  return { outputs, isStatic };
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
    const raw = step.ref;

    // Two equivalent producer forms converge on a single `{ handle?, outputs }`
    // shape: the positional shorthand `ref: [a, b]` (primary, no explicit handle)
    // and the explicit map `ref: { handle?, outputs }` (escape hatch to rename
    // the handle off name/id). A non-array, non-mapping value is neither.
    let handleRaw: unknown;
    let outputs: string[];
    if (Array.isArray(raw)) {
      handleRaw = undefined;
      outputs = readOutputs(ctx, raw, [...refPath]) ?? [];
    } else if (isObject(raw)) {
      handleRaw = raw.handle;
      outputs = readOutputs(ctx, raw.outputs, [...refPath, "outputs"]) ?? [];
    } else {
      pushDiagnostic(
        ctx,
        "error",
        "ref must be a list of outputs or a mapping of { handle?, outputs }",
        refPath,
        { code: "ref-output-undeclared" },
      );
      delete step.ref;
      return;
    }

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
    const explicit = typeof handleRaw === "string" ? handleRaw : undefined;
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

/**
 * Find the step a `handle` refers to within one job. An `id` match wins (and
 * must be unique); otherwise the first step whose `name` is a valid handle token
 * and slugifies to the handle is used. Returns the step plus its index so the
 * caller can mint an id and record a precise diagnostic path.
 */
function selectProducerStep(job: Job, handle: string): { step: Step; idx: number } | undefined {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  let idMatch: { step: Step; idx: number } | undefined;
  let idCount = 0;
  steps.forEach((step, idx) => {
    if (isObject(step) && step.id === handle) {
      idCount++;
      idMatch ??= { step, idx };
    }
  });
  if (idCount === 1 && idMatch) return idMatch;
  if (idCount > 1) return undefined;

  let nameMatch: { step: Step; idx: number } | undefined;
  steps.forEach((step, idx) => {
    if (nameMatch) return;
    if (
      isObject(step) &&
      typeof step.name === "string" &&
      NAME_RE.test(step.name) &&
      slugify(step.name) === handle
    ) {
      nameMatch = { step, idx };
    }
  });
  return nameMatch;
}

/**
 * Lazily synthesize inferred producers for `handle` in every job that declares a
 * matching step, skipping any (handle, job) pair an explicit producer already
 * owns. Idempotent per handle. Inferred producers start with an empty output set
 * that accrues as references resolve; a run producer also carries a static
 * `$GITHUB_OUTPUT` scan used to validate referenced outputs. Synthesis is keyed
 * to referenced handles only, so unrelated named steps never collide.
 */
function ensureSynthesized(handle: string, state: ScanState): void {
  if (!handle || state.attempted.has(handle)) return;
  state.attempted.add(handle);

  const haveJob = new Set((state.byHandle.get(handle) ?? []).map((p) => p.jobId));

  for (const [jobId, job] of Object.entries(state.jobs)) {
    if (haveJob.has(jobId)) continue;
    const found = selectProducerStep(job, handle);
    if (!found) continue;
    const { step, idx } = found;

    let used = state.usedByJob.get(jobId);
    if (!used) {
      used = collectUsedStepIds(Array.isArray(job.steps) ? job.steps : []);
      state.usedByJob.set(jobId, used);
    }
    const stepId = ensureStepId(step, used, `ref_${jobId}_step_${idx + 1}`);
    const kind: "action" | "run" = typeof step.uses === "string" ? "action" : "run";
    const scan =
      kind === "run" && typeof step.run === "string" ? scanGithubOutputWrites(step.run) : undefined;

    const producer: RefProducer = {
      jobId,
      job,
      stepId,
      handle,
      outputs: new Set<string>(),
      kind,
      path: ["jobs", jobId, "steps", idx],
      inferred: true,
      scan,
    };
    const peers = state.byHandle.get(handle) ?? [];
    peers.push(producer);
    state.byHandle.set(handle, peers);
  }
}

function resolveRef(
  segments: string[],
  consumerJobId: string,
  consumerStepId: string | undefined,
  consumerStepIdx: number | undefined,
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

  // Lazily synthesize inferred producers for the referenced handle before any
  // lookup. For the qualified shape the handle is the second segment; otherwise
  // it is the first. This makes `ref:` optional: a step becomes a producer the
  // moment something references it.
  const first = segments[0];
  if (segments.length >= 3 && first !== undefined && state.jobs[first]) {
    ensureSynthesized(segments[1] ?? "", state);
  } else {
    ensureSynthesized(first ?? "", state);
  }

  // Qualified ref.<job>.<handle>.<output>.
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

  const selfStep =
    producer.stepId === consumerStepId ||
    (consumerStepIdx !== undefined && producer.path[3] === consumerStepIdx);
  if (selfStep && producer.jobId === consumerJobId) {
    pushDiagnostic(
      state.ctx,
      "error",
      `ref handle "${producer.handle}" references its own step`,
      path,
      { code: "ref-self" },
    );
    return original;
  }

  if (producer.inferred) {
    // Inferred producers accrue their output set from the references themselves.
    // A run producer with a fully static $GITHUB_OUTPUT scan is authoritative: a
    // reference to an output it never writes is a hard error. Any dynamic or
    // un-dissectable write (or a script with no statically resolvable writes)
    // degrades to a single warning and wires the reference anyway. The scan is
    // never trusted to prove an output absent from a script it could not fully
    // parse.
    if (producer.kind === "run" && producer.scan) {
      const authoritative = producer.scan.isStatic && producer.scan.outputs.size > 0;
      if (authoritative && !producer.scan.outputs.has(name)) {
        pushDiagnostic(
          state.ctx,
          "error",
          `ref output "${name}" is never written to $GITHUB_OUTPUT by inferred run handle "${producer.handle}"`,
          path,
          { code: "ref-output-unwritten" },
        );
        return original;
      }
      if (!authoritative && !producer.warnedDynamic) {
        producer.warnedDynamic = true;
        pushDiagnostic(
          state.ctx,
          "warning",
          `cannot statically verify the $GITHUB_OUTPUT writes of inferred run handle "${producer.handle}"; wiring its ref outputs anyway`,
          path,
          { code: "ref-output-unscannable" },
        );
      }
    }
    producer.outputs.add(name);
  } else if (!producer.outputs.has(name)) {
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
  consumerStepIdx: number | undefined,
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
        out += resolveRef(segments, consumerJobId, consumerStepId, consumerStepIdx, path, state);
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
      scanRuntimeExprs(s, (inner) =>
        rewriteExprBody(inner, jobId, undefined, undefined, path, state),
      );
    if (typeof v === "string") (job as Record<string, unknown>)[key] = rewrite(v);
    else walkStrings(v, rewrite);
  }
  steps.forEach((step, idx) => {
    if (!isObject(step)) return;
    const stepId = typeof step.id === "string" ? step.id : undefined;
    const path: Path = ["jobs", jobId, "steps", idx];
    const rewrite = (s: string) =>
      scanRuntimeExprs(s, (inner) => rewriteExprBody(inner, jobId, stepId, idx, path, state));
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
  const state: ScanState = {
    ctx,
    byHandle,
    jobs,
    synth,
    edges,
    attempted: new Set(),
    usedByJob: new Map(),
  };
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

import { cloneNode, deriveNode, type Job, type Step, transformSteps, visitJobs } from "../ir.js";
import { KEY_ORDER, type ParseContext, type Path, setKeyOrder } from "../parser.js";
import {
  asStepArray,
  collectUsedStepIds,
  combineIf,
  ensureStepId,
  isObject,
  pushDiagnostic,
} from "./helpers.js";
import type { Pass } from "./registry.js";

interface RetrySpec {
  runsOn: unknown;
  whenExitCodes?: number[];
}

interface NormalizedFallback {
  steps: Step[];
  recover: boolean;
  retry: RetrySpec | null;
}

/** A guarded step lifted into its own sibling recovery job. */
interface RetryJobSpec {
  jobId: string;
  step: Step;
  runsOn: unknown;
  gateExpr?: string;
}

interface RetryCollector {
  specs: RetryJobSpec[];
  jobOutputs: { jobId: string; name: string; expr: string }[];
}

function normalizeRetry(ctx: ParseContext, raw: unknown, path?: Path): RetrySpec | null {
  if (!isObject(raw)) {
    pushDiagnostic(
      ctx,
      "warning",
      `fallback.retry must be a mapping with "runs-on" (got ${
        raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw
      }); ignoring retry`,
      path,
    );
    return null;
  }
  const runsOn = raw["runs-on"] ?? raw.runs_on;
  if (
    runsOn === undefined ||
    runsOn === null ||
    (typeof runsOn === "string" && runsOn.trim().length === 0)
  ) {
    pushDiagnostic(
      ctx,
      "warning",
      `fallback.retry requires a "runs-on" runner; ignoring retry`,
      path ? [...path, "runs-on"] : path,
    );
    return null;
  }
  let whenExitCodes: number[] | undefined;
  const wec = raw["when-exit-code"];
  if (wec !== undefined) {
    const codes = Array.isArray(wec) ? wec : [wec];
    const valid = codes.filter((c): c is number => typeof c === "number" && Number.isInteger(c));
    if (valid.length !== codes.length) {
      pushDiagnostic(
        ctx,
        "warning",
        `fallback.retry.when-exit-code must be an integer or list of integers; ignoring invalid entries`,
        path ? [...path, "when-exit-code"] : path,
      );
    }
    if (valid.length > 0) whenExitCodes = valid;
  }
  return { runsOn, whenExitCodes };
}

function normalizeFallback(ctx: ParseContext, fb: unknown, path?: Path): NormalizedFallback {
  if (Array.isArray(fb)) return { steps: asStepArray(fb), recover: false, retry: null };
  if (isObject(fb)) {
    if (fb.steps !== undefined && !Array.isArray(fb.steps)) {
      pushDiagnostic(
        ctx,
        "warning",
        `fallback.steps must be a list of steps (got ${typeof fb.steps}); ignoring fallback`,
        path ? [...path, "steps"] : path,
      );
      return { steps: [], recover: false, retry: null };
    }
    if (fb.recover !== undefined && typeof fb.recover !== "boolean") {
      pushDiagnostic(
        ctx,
        "warning",
        `fallback.recover must be a boolean (got ${typeof fb.recover}); treating as ${Boolean(fb.recover)}`,
        path ? [...path, "recover"] : path,
      );
    }
    const retry =
      fb.retry !== undefined
        ? normalizeRetry(ctx, fb.retry, path ? [...path, "retry"] : path)
        : null;
    return { steps: asStepArray(fb.steps), recover: Boolean(fb.recover), retry };
  }
  pushDiagnostic(
    ctx,
    "warning",
    `fallback must be a list of steps or a mapping with "steps" (got ${fb === null ? "null" : typeof fb}); ignoring fallback`,
    path,
  );
  return { steps: [], recover: false, retry: null };
}

function applyIf(step: Step, guard: string): Step {
  const combined = combineIf(guard, step.if);
  if (combined) step.if = combined;
  return step;
}

/** Expand a single step's `fallback:` block, recursing into nested fallbacks. */
function expandStepFallback(
  ctx: ParseContext,
  jobId: string,
  step: Step,
  idx: number,
  used: Set<string>,
  collector: RetryCollector,
): Step[] {
  if (!isObject(step) || step.fallback == null) return [step];
  const {
    steps: fbSteps,
    recover,
    retry,
  } = normalizeFallback(ctx, step.fallback, ["jobs", jobId, "steps", idx, "fallback"]);
  delete step.fallback;

  // retry mode: lift the guarded step into a sibling recovery job (different runner).
  if (retry) liftRetryStep(ctx, jobId, step, idx, used, retry, collector);

  if (fbSteps.length === 0) return [step];

  const id = ensureStepId(step, used, `actio_${jobId}_step_${idx + 1}`);
  const guard = recover
    ? `steps.${id}.outcome == 'failure'`
    : `failure() && steps.${id}.conclusion == 'failure'`;
  if (recover && step["continue-on-error"] === undefined) {
    // True try/catch: swallow the failure so the job can continue.
    step["continue-on-error"] = true;
  }
  const out: Step[] = [step];
  fbSteps.forEach((f, j) => {
    const clone = applyIf(deriveNode(ctx, step, cloneNode(ctx, f)), guard);
    // A fallback step may itself carry a `fallback:` — expand it recursively.
    out.push(...expandStepFallback(ctx, jobId, clone, j, used, collector));
  });
  return out;
}

/**
 * Lift a guarded step into a sibling recovery job spec. The original step stays
 * in its job; the clone is what re-runs on the fallback runner. When
 * `when-exit-code` is set on a POSIX `run` step we also rewrite the original
 * step to publish its exit code so the retry job can gate on it.
 */
function liftRetryStep(
  ctx: ParseContext,
  jobId: string,
  step: Step,
  idx: number,
  used: Set<string>,
  retry: RetrySpec,
  collector: RetryCollector,
): void {
  // Clone the clean executable before any exit-capture mutation; strip the
  // origin-only wiring so the retry job runs the command fresh.
  const retryStep = cloneNode(ctx, step);
  delete retryStep.id;
  delete retryStep.if;
  delete retryStep.fallback;
  delete retryStep["continue-on-error"];

  let gateExpr: string | undefined;
  const codes = retry.whenExitCodes;
  if (codes && codes.length > 0) {
    const path: Path = ["jobs", jobId, "steps", idx, "fallback", "retry", "when-exit-code"];
    const shell = step.shell;
    const posix = shell === undefined || shell === "bash" || shell === "sh";
    if (typeof step.run !== "string") {
      pushDiagnostic(
        ctx,
        "warning",
        `Job "${jobId}": fallback.retry.when-exit-code only applies to "run" steps; retrying on any failure`,
        path,
      );
    } else if (!posix) {
      pushDiagnostic(
        ctx,
        "warning",
        `Job "${jobId}": fallback.retry.when-exit-code requires a POSIX shell (bash/sh); retrying on any failure`,
        path,
      );
    } else {
      const id = ensureStepId(step, used, `actio_${jobId}_step_${idx + 1}`);
      const outName = `${id}_exit_code`;
      // An EXIT trap captures the script's real failing exit code (faithful for
      // single- and multi-line scripts under `set -e`) and publishes it, while
      // the script still exits non-zero so `failure()` fires.
      step.run = `trap 'echo "exit_code=$?" >> "$GITHUB_OUTPUT"' EXIT\n${step.run}`;
      collector.jobOutputs.push({ jobId, name: outName, expr: `steps.${id}.outputs.exit_code` });
      gateExpr = codes.map((c) => `needs.${jobId}.outputs.${outName} == '${c}'`).join(" || ");
    }
  }

  collector.specs.push({ jobId, step: retryStep, runsOn: retry.runsOn, gateExpr });
}

/** Expand `fallback:` keys nested on individual steps into recover (try/catch) logic. */
function processStepFallbacks(
  ctx: ParseContext,
  jobId: string,
  job: Job,
  collector: RetryCollector,
): void {
  if (!Array.isArray(job.steps)) return;
  const used = collectUsedStepIds(job.steps);
  transformSteps(ctx, jobId, job, (step, idx) =>
    expandStepFallback(ctx, jobId, step, idx, used, collector),
  );
}

/** Expand a job-level `fallback:` block into notify steps gated on `failure()`. */
function processJobFallback(ctx: ParseContext, job: Job, jobId: string): void {
  if (job.fallback == null) return;
  const {
    steps: fbSteps,
    recover,
    retry,
  } = normalizeFallback(ctx, job.fallback, ["jobs", jobId, "fallback"]);
  delete job.fallback;
  if (retry) {
    pushDiagnostic(
      ctx,
      "warning",
      `Job "${jobId}": fallback.retry is only supported on step-level fallback; ignoring`,
      ["jobs", jobId, "fallback", "retry"],
    );
  }
  // A reusable-workflow job (`uses:`) cannot also declare `steps:`; appending
  // fallback steps would emit schema-invalid output. Skip and warn instead.
  if (typeof job.uses === "string") {
    pushDiagnostic(
      ctx,
      "warning",
      `Job "${jobId}": job-level fallback is not supported on a reusable-workflow (uses) job; ignoring`,
      ["jobs", jobId, "fallback"],
    );
    return;
  }
  if (recover) {
    pushDiagnostic(
      ctx,
      "warning",
      `Job "${jobId}": recover is only supported on step-level fallback; treating job-level fallback as notify`,
      ["jobs", jobId, "fallback"],
    );
  }
  if (!Array.isArray(job.steps)) job.steps = [];
  const used = collectUsedStepIds(job.steps);
  const sink: RetryCollector = { specs: [], jobOutputs: [] };
  for (const f of fbSteps) {
    const clone = applyIf(deriveNode(ctx, job, cloneNode(ctx, f)), "failure()");
    // A job-level fallback step may itself carry a nested `fallback:`.
    for (const s of expandStepFallback(ctx, jobId, clone, job.steps.length, used, sink)) {
      job.steps.push(s);
    }
  }
}

function stepLabel(step: Step): string {
  if (typeof step.name === "string" && step.name.trim()) return step.name.trim();
  if (typeof step.uses === "string" && step.uses.trim()) return step.uses.trim();
  if (typeof step.run === "string") {
    const first = step.run.split("\n").find((l) => l.trim().length > 0);
    if (first) return first.trim();
  }
  return "step";
}

function runnerLabel(runsOn: unknown): string {
  if (typeof runsOn === "string") return runsOn;
  if (Array.isArray(runsOn)) {
    const labels = runsOn.filter((x): x is string => typeof x === "string");
    if (labels.length) return labels.join(", ");
  }
  return "fallback runner";
}

function buildRetryJob(ctx: ParseContext, originJob: Job, jobId: string, spec: RetryJobSpec): Job {
  const ifExpr = spec.gateExpr ? combineIf("failure()", spec.gateExpr) : "failure()";
  const job: Job = deriveNode(ctx, originJob, {
    name: `Retry "${stepLabel(spec.step)}" on ${runnerLabel(spec.runsOn)}`,
    needs: [jobId],
    if: ifExpr,
    "runs-on": spec.runsOn,
    steps: [spec.step],
  });
  setKeyOrder(job, ["name", "needs", "if", "runs-on", "steps"]);
  return job;
}

function uniqueJobId(jobId: string, index: number, taken: Set<string>): string {
  const base = index === 0 ? `${jobId}_retry` : `${jobId}_retry_${index + 1}`;
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  return id;
}

/**
 * Insert collected retry jobs into `ctx.data.jobs`, each placed right after its
 * origin job, and publish the origin step exit-code outputs. Rebuilds the jobs
 * map (mirroring dynamic-matrix) so KEY_ORDER stays faithful for emit.
 */
function applyRetryJobs(ctx: ParseContext, collector: RetryCollector): void {
  const jobs = ctx.data.jobs;
  if (!isObject(jobs)) return;

  for (const o of collector.jobOutputs) {
    const job = (jobs as Record<string, unknown>)[o.jobId];
    if (!isObject(job)) continue;
    const j = job as Job;
    if (!isObject(j.outputs)) j.outputs = {};
    (j.outputs as Record<string, unknown>)[o.name] = `\${{ ${o.expr} }}`;
  }

  const byJob = new Map<string, RetryJobSpec[]>();
  for (const spec of collector.specs) {
    const arr = byJob.get(spec.jobId);
    if (arr) arr.push(spec);
    else byJob.set(spec.jobId, [spec]);
  }

  const recorded = (jobs as Record<symbol, unknown>)[KEY_ORDER] as string[] | undefined;
  const seen = new Set(recorded ?? []);
  const order = recorded
    ? [...recorded.filter((k) => k in jobs), ...Object.keys(jobs).filter((k) => !seen.has(k))]
    : Object.keys(jobs);

  const allJobIds = new Set(order);
  const rebuilt: Record<string, unknown> = {};
  const rebuiltOrder: string[] = [];
  for (const jobId of order) {
    const originJob = (jobs as Record<string, unknown>)[jobId];
    rebuilt[jobId] = originJob;
    rebuiltOrder.push(jobId);
    const specs = byJob.get(jobId);
    if (!specs || !isObject(originJob)) continue;
    specs.forEach((spec, i) => {
      const retryId = uniqueJobId(jobId, i, allJobIds);
      rebuilt[retryId] = buildRetryJob(ctx, originJob as Job, jobId, spec);
      rebuiltOrder.push(retryId);
      allJobIds.add(retryId);
    });
  }
  setKeyOrder(rebuilt, rebuiltOrder);
  ctx.data.jobs = rebuilt;
}

/**
 * fallback pass: turns `fallback:` blocks into explicit conditional steps.
 * - step-level fallback => recover: guarded step gets `continue-on-error: true`
 *   + an id; fallback steps run on `steps.<id>.outcome == 'failure'`.
 * - step-level fallback => retry: the guarded step is lifted into a sibling
 *   `<job>_retry` job (`needs: [orig]`, `if: failure()`) on a different runner,
 *   optionally gated on the original step's exit code.
 * - job-level fallback  => notify: fallback steps appended with `if: failure()`
 *   (the job still fails).
 */
export function fallbackPass(ctx: ParseContext): void {
  const collector: RetryCollector = { specs: [], jobOutputs: [] };
  visitJobs(ctx, ({ id: jobId, job }) => {
    processStepFallbacks(ctx, jobId, job, collector);
    processJobFallback(ctx, job, jobId);
  });
  if (collector.specs.length > 0) applyRetryJobs(ctx, collector);
}

/** Wrap steps with try/catch before dynamic-matrix moves them between jobs. */
export const fallback: Pass = {
  name: "fallback",
  runsAfter: ["fragments", "retry"],
  apply: fallbackPass,
};

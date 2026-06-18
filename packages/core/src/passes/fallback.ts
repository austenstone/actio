import { cloneNode, deriveNode, type Job, type Step, transformSteps, visitJobs } from "../ir.js";
import type { ParseContext } from "../parser.js";
import {
  asStepArray,
  collectUsedStepIds,
  combineIf,
  ensureStepId,
  isObject,
  pushDiagnostic,
} from "./helpers.js";
import type { Pass } from "./registry.js";

interface NormalizedFallback {
  steps: Step[];
  recover: boolean;
}

function normalizeFallback(fb: unknown): NormalizedFallback {
  if (Array.isArray(fb)) return { steps: asStepArray(fb), recover: false };
  if (isObject(fb)) {
    return { steps: asStepArray(fb.steps), recover: Boolean(fb.recover) };
  }
  return { steps: [], recover: false };
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
): Step[] {
  if (!isObject(step) || step.fallback == null) return [step];
  const { steps: fbSteps, recover } = normalizeFallback(step.fallback);
  delete step.fallback;
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
    out.push(...expandStepFallback(ctx, jobId, clone, j, used));
  });
  return out;
}

/** Expand `fallback:` keys nested on individual steps into recover (try/catch) logic. */
function processStepFallbacks(ctx: ParseContext, jobId: string, job: Job): void {
  if (!Array.isArray(job.steps)) return;
  const used = collectUsedStepIds(job.steps);
  transformSteps(ctx, jobId, job, (step, idx) => expandStepFallback(ctx, jobId, step, idx, used));
}

/** Expand a job-level `fallback:` block into notify steps gated on `failure()`. */
function processJobFallback(ctx: ParseContext, job: Job, jobId: string): void {
  if (job.fallback == null) return;
  const { steps: fbSteps, recover } = normalizeFallback(job.fallback);
  delete job.fallback;
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
  for (const f of fbSteps) {
    const clone = applyIf(deriveNode(ctx, job, cloneNode(ctx, f)), "failure()");
    // A job-level fallback step may itself carry a nested `fallback:`.
    for (const s of expandStepFallback(ctx, jobId, clone, job.steps.length, used)) {
      job.steps.push(s);
    }
  }
}

/**
 * fallback pass: turns `fallback:` blocks into explicit conditional steps.
 * - step-level fallback => recover: guarded step gets `continue-on-error: true`
 *   + an id; fallback steps run on `steps.<id>.outcome == 'failure'`.
 * - job-level fallback  => notify: fallback steps appended with `if: failure()`
 *   (the job still fails).
 */
export function fallbackPass(ctx: ParseContext): void {
  visitJobs(ctx, ({ id: jobId, job }) => {
    processStepFallbacks(ctx, jobId, job);
    processJobFallback(ctx, job, jobId);
  });
}

/** Wrap steps with try/catch before dynamic_matrix moves them between jobs. */
export const fallback: Pass = {
  name: "fallback",
  runsAfter: ["fragments", "retry"],
  apply: fallbackPass,
};

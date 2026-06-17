import type { ParseContext } from "../parser.js";
import {
  type Job,
  type Step,
  asArray,
  clone,
  collectUsedStepIds,
  combineIf,
  ensureStepId,
  isObject,
  pushDiagnostic,
} from "./helpers.js";

interface NormalizedFallback {
  steps: Step[];
  recover: boolean;
}

function normalizeStepFallback(fb: unknown): NormalizedFallback {
  if (Array.isArray(fb)) return { steps: fb, recover: false };
  if (isObject(fb)) {
    return { steps: asArray((fb as Step).steps), recover: Boolean((fb as Step).recover) };
  }
  return { steps: [], recover: false };
}

function normalizeJobFallback(fb: unknown): NormalizedFallback {
  if (Array.isArray(fb)) return { steps: fb, recover: false };
  if (isObject(fb)) {
    return { steps: asArray((fb as Step).steps), recover: Boolean((fb as Step).recover) };
  }
  return { steps: [], recover: false };
}

function applyIf(step: Step, guard: string): Step {
  const combined = combineIf(guard, step.if);
  if (combined) step.if = combined;
  return step;
}

/** Expand `fallback:` keys nested on individual steps into recover (try/catch) logic. */
function processStepFallbacks(job: Job, jobId: string): void {
  if (!Array.isArray(job.steps)) return;
  const used = collectUsedStepIds(job.steps);
  const out: Step[] = [];
  job.steps.forEach((step: Step, idx: number) => {
    if (!isObject(step) || step.fallback == null) {
      out.push(step);
      return;
    }
    const { steps: fbSteps, recover } = normalizeStepFallback(step.fallback);
    delete step.fallback;
    if (fbSteps.length === 0) {
      out.push(step);
      return;
    }
    const id = ensureStepId(step, used, `actio_${jobId}_step_${idx + 1}`);
    if (recover) {
      // True try/catch: swallow the failure so the job can continue.
      if (step["continue-on-error"] === undefined) step["continue-on-error"] = true;
      out.push(step);
      for (const f of fbSteps) {
        out.push(applyIf(clone(f), `steps.${id}.outcome == 'failure'`));
      }
    } else {
      // Notify/cleanup (default): the job still fails. `failure()` is required for
      // the step to run at all after a failure; the conclusion check scopes it to
      // this specific step.
      out.push(step);
      for (const f of fbSteps) {
        out.push(applyIf(clone(f), `failure() && steps.${id}.conclusion == 'failure'`));
      }
    }
  });
  job.steps = out;
}

/** Expand a job-level `fallback:` block into notify steps gated on `failure()`. */
function processJobFallback(ctx: ParseContext, job: Job, jobId: string): void {
  if (job.fallback == null) return;
  const { steps: fbSteps, recover } = normalizeJobFallback(job.fallback);
  delete job.fallback;
  if (recover) {
    pushDiagnostic(
      ctx,
      "warning",
      `Job "${jobId}": recover is only supported on step-level fallback; treating job-level fallback as notify`,
      ["jobs", jobId, "fallback"],
    );
  }
  if (!Array.isArray(job.steps)) job.steps = [];
  for (const f of fbSteps) {
    job.steps.push(applyIf(clone(f), "failure()"));
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
  const jobs = ctx.data.jobs;
  if (!isObject(jobs)) return;
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObject(job)) continue;
    processStepFallbacks(job as Job, jobId);
    processJobFallback(ctx, job as Job, jobId);
  }
}

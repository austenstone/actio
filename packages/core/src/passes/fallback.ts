import { type Job, type Step, cloneNode, deriveNode, transformSteps, visitJobs } from "../ir.js";
import type { ParseContext } from "../parser.js";
import {
  asArray,
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
function processStepFallbacks(ctx: ParseContext, jobId: string, job: Job): void {
  if (!Array.isArray(job.steps)) return;
  const used = collectUsedStepIds(job.steps);
  transformSteps(ctx, jobId, job, (step, idx) => {
    if (!isObject(step) || step.fallback == null) return [step];
    const { steps: fbSteps, recover } = normalizeStepFallback(step.fallback);
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
    for (const f of fbSteps) {
      out.push(applyIf(deriveNode(ctx, step, cloneNode(ctx, f)), guard));
    }
    return out;
  });
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
    job.steps.push(applyIf(deriveNode(ctx, job, cloneNode(ctx, f)), "failure()"));
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

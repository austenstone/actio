import {
  cloneNode,
  deriveNode,
  type Job,
  recordOrigin,
  type Step,
  transformSteps,
  visitJobs,
  workflow,
} from "../ir.js";
import { type ParseContext, type Path, setKeyOrder } from "../parser.js";
import { ANNOTATE_JOB_ID } from "./annotate.js";
import {
  asStepArray,
  collectUsedStepIds,
  combineIf,
  ensureStepId,
  expectMapping,
  isObject,
  mergeNeeds,
  pushDiagnostic,
} from "./helpers.js";
import type { Pass } from "./registry.js";

// --- vocabulary (single source of truth) ----------------------------------

/** Branch-group keys valid both as step/job modifiers and as `finally:` groups. */
const BRANCH_KEYS = new Set(["on_success", "on_failure", "on_abort"]);
/** Every same-unit hook key (`ensure:` plus the branch keys). */
const STEP_HOOK_KEYS = new Set(["ensure", ...BRANCH_KEYS]);
/** Hook keys plus `finally`, used to detect illegal hook-on-hook nesting (#10). */
const LIFECYCLE_KEYS = ["ensure", "on_success", "on_failure", "on_abort", "finally"];
/** `when:` outcome sugar → `needs.<job>.result` value. */
const WHEN_STATES: Record<string, string> = {
  failed: "failure",
  succeeded: "success",
  cancelled: "cancelled",
  skipped: "skipped",
};
/** Canonical key order for emitted finally jobs (extras append after `steps`). */
const FINALLY_JOB_KEY_ORDER = ["name", "runs-on", "needs", "if", "timeout-minutes", "steps"];
/** Default bound on the cancel path so a hung teardown can't outlive the cancel. */
const CANCEL_TIMEOUT_MINUTES = 5;

// --- §5 diagnostic messages -----------------------------------------------

const MSG_NOT_MAPPING = "finally must be a mapping of teardown jobs";
const MSG_WRONG_SCOPE = "finally: is workflow-scoped; use ensure: for job/step teardown";
const MSG_STEP_ON_ABORT =
  "step-level on_abort only sees step cancellation; run-level cancel belongs in a workflow finally:";
const MSG_HOOK_NESTING = "lifecycle hooks cannot nest";

// --- shared helpers -------------------------------------------------------

function applyIf(step: Step, guard: string): Step {
  const combined = combineIf(guard, step.if);
  if (combined) step.if = combined;
  return step;
}

function hasLifecycleKey(step: Step): boolean {
  return LIFECYCLE_KEYS.some((k) => k in step);
}

function stripLifecycleKeys(step: Step): void {
  for (const k of LIFECYCLE_KEYS) delete step[k];
}

/** Guard for a same-unit hook attached to a step (keys on `outcome`). */
function stepHookGuard(key: string, stepId: string): string {
  if (key === "ensure") return "always()";
  if (key === "on_abort") return "cancelled()";
  if (key === "on_failure") return `!cancelled() && steps.${stepId}.outcome == 'failure'`;
  return `success() && steps.${stepId}.outcome == 'success'`;
}

/** Guard for a same-unit hook attached to a job (appended teardown steps). */
function jobHookGuard(key: string): string {
  if (key === "ensure") return "always()";
  if (key === "on_success") return "success()";
  if (key === "on_failure") return "failure()";
  return "cancelled()";
}

function hookKeysOf(node: Record<string, unknown>): string[] {
  return Object.keys(node).filter((k) => STEP_HOOK_KEYS.has(k));
}

/** Push #10 and strip nested keys if a generated hook step carries its own hook. */
function guardAgainstNesting(ctx: ParseContext, step: Step, path: Path): void {
  if (!hasLifecycleKey(step)) return;
  pushDiagnostic(ctx, "error", MSG_HOOK_NESTING, path, { code: "hook-nesting" });
  stripLifecycleKeys(step);
}

// --- step-scope hooks -----------------------------------------------------

function expandStepHooks(
  ctx: ParseContext,
  jobId: string,
  step: Step,
  idx: number,
  used: Set<string>,
): Step[] {
  if (!isObject(step)) return [step];

  if ("finally" in step) {
    pushDiagnostic(ctx, "error", MSG_WRONG_SCOPE, ["jobs", jobId, "steps", idx, "finally"], {
      code: "finally-wrong-scope",
      hint: "use ensure: for step teardown",
    });
    delete step.finally;
  }

  const keys = hookKeysOf(step);
  if (keys.length === 0) return [step];

  const out: Step[] = [step];
  let stepId: string | undefined;
  for (const key of keys) {
    const raw = step[key];
    delete step[key];
    const keyPath: Path = ["jobs", jobId, "steps", idx, key];
    if (!Array.isArray(raw)) {
      pushDiagnostic(ctx, "error", `${key} must be a list of steps`, keyPath, {
        code: "hook-not-step-list",
      });
      continue;
    }
    if (raw.length === 0) {
      if (key === "ensure") {
        pushDiagnostic(ctx, "warning", "empty ensure: has no effect", keyPath, {
          code: "empty-ensure",
        });
      }
      continue;
    }
    if (key === "on_abort") {
      pushDiagnostic(ctx, "warning", MSG_STEP_ON_ABORT, keyPath, { code: "step-on-abort" });
    }
    if ((key === "on_failure" || key === "on_success") && stepId === undefined) {
      stepId = ensureStepId(step, used, `actio_${jobId}_step_${idx + 1}`);
    }
    const guard = stepHookGuard(key, stepId ?? "");
    for (const h of asStepArray(raw)) {
      const clone = applyIf(deriveNode(ctx, step, cloneNode(ctx, h)), guard);
      guardAgainstNesting(ctx, clone, keyPath);
      out.push(clone);
    }
  }
  return out;
}

function processStepHooks(ctx: ParseContext, jobId: string, job: Job): void {
  if (!Array.isArray(job.steps)) return;
  const used = collectUsedStepIds(job.steps);
  transformSteps(ctx, jobId, job, (step, idx) => expandStepHooks(ctx, jobId, step, idx, used));
}

// --- job-scope modifiers --------------------------------------------------

function processJobModifiers(ctx: ParseContext, job: Job, basePath: Path): void {
  if ("finally" in job) {
    pushDiagnostic(ctx, "error", MSG_WRONG_SCOPE, [...basePath, "finally"], {
      code: "finally-wrong-scope",
      hint: "use ensure: for job teardown",
    });
    delete job.finally;
  }

  const keys = hookKeysOf(job);
  if (keys.length === 0) return;
  if (!Array.isArray(job.steps)) job.steps = [];

  for (const key of keys) {
    const raw = job[key];
    delete job[key];
    const keyPath: Path = [...basePath, key];
    if (!Array.isArray(raw)) {
      pushDiagnostic(ctx, "error", `${key} must be a list of steps`, keyPath, {
        code: "hook-not-step-list",
      });
      continue;
    }
    if (raw.length === 0) {
      if (key === "ensure") {
        pushDiagnostic(ctx, "warning", "empty ensure: has no effect", keyPath, {
          code: "empty-ensure",
        });
      }
      continue;
    }
    const guard = jobHookGuard(key);
    for (const h of asStepArray(raw)) {
      const clone = applyIf(deriveNode(ctx, job, cloneNode(ctx, h)), guard);
      guardAgainstNesting(ctx, clone, keyPath);
      job.steps.push(clone);
    }
  }
}

// --- finally: top-level ---------------------------------------------------

interface WhenResult {
  expr: string;
  job: string;
}

function consumeWhen(
  ctx: ParseContext,
  job: Job,
  realJobSet: Set<string>,
  path: Path,
): WhenResult | undefined {
  const when = job.when;
  if (when === undefined) return undefined;
  delete job.when;
  if (typeof when !== "string") {
    pushDiagnostic(
      ctx,
      "error",
      `Unknown outcome "${String(when)}"; use failed / succeeded / cancelled / skipped`,
      [...path, "when"],
      {
        code: "when-unknown-state",
      },
    );
    return undefined;
  }
  const dot = when.lastIndexOf(".");
  const jobRef = dot >= 0 ? when.slice(0, dot) : when;
  const state = dot >= 0 ? when.slice(dot + 1) : "";
  if (!realJobSet.has(jobRef)) {
    pushDiagnostic(ctx, "error", `Unknown job "${jobRef}" in when:`, [...path, "when"], {
      code: "when-unknown-job",
      hint: `known jobs: ${[...realJobSet].join(", ")}`,
    });
    return undefined;
  }
  const result = WHEN_STATES[state];
  if (result === undefined) {
    pushDiagnostic(
      ctx,
      "error",
      `Unknown outcome "${state}"; use failed / succeeded / cancelled / skipped`,
      [...path, "when"],
      {
        code: "when-unknown-state",
      },
    );
    return undefined;
  }
  return { expr: `needs.${jobRef}.result == '${result}'`, job: jobRef };
}

function checkSiblingNeeds(
  ctx: ParseContext,
  authorNeeds: unknown,
  finallyNames: Set<string>,
  path: Path,
): void {
  const list =
    typeof authorNeeds === "string" ? [authorNeeds] : Array.isArray(authorNeeds) ? authorNeeds : [];
  for (const n of list) {
    if (typeof n === "string" && finallyNames.has(n)) {
      pushDiagnostic(
        ctx,
        "error",
        "finally jobs cannot depend on each other in v1",
        [...path, "needs"],
        {
          code: "finally-needs-sibling",
        },
      );
      return;
    }
  }
}

function finalizeFinallyJob(job: Job): void {
  setKeyOrder(job, FINALLY_JOB_KEY_ORDER);
}

function buildNeeds(
  authorNeeds: unknown,
  realJobs: string[],
  finallyNames: Set<string>,
  extra: string[],
): string[] {
  return mergeNeeds(mergeNeeds(authorNeeds, realJobs), extra).filter((n) => !finallyNames.has(n));
}

/** Process one unconditional teardown job: normal `!cancelled()` + optional companion. */
function processUnconditional(
  ctx: ParseContext,
  name: string,
  body: unknown,
  jobs: Record<string, Job>,
  realJobs: string[],
  realJobSet: Set<string>,
  finallyNames: Set<string>,
  hasOnAbort: boolean,
): void {
  const path: Path = ["finally", name];
  if (!expectMapping(ctx, body, path, { message: MSG_NOT_MAPPING, code: "finally-not-mapping" })) {
    return;
  }
  if (realJobSet.has(name)) {
    pushDiagnostic(
      ctx,
      "error",
      `finally job "${name}" collides with a job of the same name`,
      path,
      {
        code: "finally-job-collision",
      },
    );
    return;
  }
  const job = body as Job;
  recordOrigin(ctx, job, path);
  processStepHooks(ctx, name, job);
  processJobModifiers(ctx, job, path);

  const authorNeeds = job.needs;
  const authorIf = typeof job.if === "string" ? job.if : undefined;
  checkSiblingNeeds(ctx, authorNeeds, finallyNames, path);
  const needs = buildNeeds(authorNeeds, realJobs, finallyNames, []);
  if (needs.length > 0) job.needs = needs;
  else delete job.needs;
  job.if = combineIf("!cancelled()", authorIf);
  finalizeFinallyJob(job);
  jobs[name] = job;

  if (!hasOnAbort) {
    const companion = cloneNode(ctx, job);
    companion.if = combineIf("cancelled()", authorIf);
    if (companion["timeout-minutes"] === undefined) {
      companion["timeout-minutes"] = CANCEL_TIMEOUT_MINUTES;
    }
    finalizeFinallyJob(companion);
    jobs[`${name}-on-cancel`] = companion;
  }
}

/** Process an `on_success:`/`on_failure:`/`on_abort:` branch group of finally jobs. */
function processBranchGroup(
  ctx: ParseContext,
  branchKey: string,
  value: unknown,
  jobs: Record<string, Job>,
  realJobs: string[],
  realJobSet: Set<string>,
  finallyNames: Set<string>,
): void {
  // `on_abort: []` (or empty map) is the explicit opt-out: no cancel job.
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    pushDiagnostic(ctx, "error", MSG_NOT_MAPPING, ["finally", branchKey], {
      code: "finally-not-mapping",
    });
    return;
  }
  if (!isObject(value)) {
    pushDiagnostic(ctx, "error", MSG_NOT_MAPPING, ["finally", branchKey], {
      code: "finally-not-mapping",
    });
    return;
  }

  const branchGuard =
    branchKey === "on_success"
      ? "success()"
      : branchKey === "on_failure"
        ? "failure()"
        : "cancelled()";
  const isCancelPath = branchKey === "on_abort";

  for (const [name, body] of Object.entries(value)) {
    const path: Path = ["finally", branchKey, name];
    if (
      !expectMapping(ctx, body, path, { message: MSG_NOT_MAPPING, code: "finally-not-mapping" })
    ) {
      continue;
    }
    if (realJobSet.has(name)) {
      pushDiagnostic(
        ctx,
        "error",
        `finally job "${name}" collides with a job of the same name`,
        path,
        {
          code: "finally-job-collision",
        },
      );
      continue;
    }
    const job = body as Job;
    recordOrigin(ctx, job, path);
    processStepHooks(ctx, name, job);
    processJobModifiers(ctx, job, path);

    const when = consumeWhen(ctx, job, realJobSet, path);
    const authorNeeds = job.needs;
    const authorIf = typeof job.if === "string" ? job.if : undefined;
    checkSiblingNeeds(ctx, authorNeeds, finallyNames, path);
    const needs = buildNeeds(authorNeeds, realJobs, finallyNames, when ? [when.job] : []);
    if (needs.length > 0) job.needs = needs;
    else delete job.needs;
    job.if = combineIf(branchGuard, when?.expr, authorIf);
    if (isCancelPath && job["timeout-minutes"] === undefined) {
      job["timeout-minutes"] = CANCEL_TIMEOUT_MINUTES;
    }
    finalizeFinallyJob(job);
    jobs[name] = job;
  }
}

function collectFinallyJobNames(block: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const [key, value] of Object.entries(block)) {
    if (BRANCH_KEYS.has(key)) {
      if (isObject(value)) for (const n of Object.keys(value)) names.add(n);
    } else {
      names.add(key);
    }
  }
  return names;
}

function processFinally(ctx: ParseContext): void {
  const wf = workflow(ctx);
  const block = wf.finally;
  if (block === undefined) return;
  if (
    !expectMapping(ctx, block, ["finally"], {
      message: MSG_NOT_MAPPING,
      code: "finally-not-mapping",
    })
  ) {
    delete wf.finally;
    return;
  }

  const existing = wf.jobs;
  const jobs: Record<string, Job> = isObject(existing) ? (existing as Record<string, Job>) : {};
  if (!isObject(existing)) wf.jobs = jobs;

  const realJobs = Object.keys(jobs).filter((k) => k !== ANNOTATE_JOB_ID);
  const realJobSet = new Set(realJobs);
  const finallyNames = collectFinallyJobNames(block);
  const hasOnAbort = Object.hasOwn(block, "on_abort");

  for (const [key, value] of Object.entries(block)) {
    if (BRANCH_KEYS.has(key)) {
      processBranchGroup(ctx, key, value, jobs, realJobs, realJobSet, finallyNames);
    } else {
      processUnconditional(ctx, key, value, jobs, realJobs, realJobSet, finallyNames, hasOnAbort);
    }
  }

  delete wf.finally;
}

/**
 * lifecycle pass: guaranteed teardown + outcome-branch hooks.
 * - `ensure:`/`on_*:` on a step  => guard steps spliced in after it (keyed on `outcome`).
 * - `ensure:`/`on_*:` on a job   => guard steps appended to the job.
 * - `finally:` (workflow-level)   => aggregator job(s) that `needs:` every real job,
 *   split into a `!cancelled()` normal path and a `cancelled()` cancel companion.
 * - `finally:` at job/step scope  => error #7 (suggests `ensure:`).
 * Runs after every multiplying/defaulting pass so it sees the fully expanded job
 * set, and before `annotate` so the synthetic job needs the guard jobs too.
 */
export function lifecyclePass(ctx: ParseContext): void {
  visitJobs(ctx, ({ id, job, path }) => {
    processStepHooks(ctx, id, job);
    processJobModifiers(ctx, job, path);
  });
  processFinally(ctx);
}

export const lifecycle: Pass = {
  name: "lifecycle",
  runsAfter: ["fragments", "retry", "fallback", "dynamic_matrix", "for_each", "job_defaults"],
  apply: lifecyclePass,
};

import {
  cloneNode,
  deriveNode,
  type Job,
  type Step,
  transformSteps,
  visitJobs,
  workflow,
} from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import {
  collectUsedStepIds,
  combineIf,
  ensureStepId,
  isObject,
  mergeNeeds,
  pushDiagnostic,
} from "./helpers.js";
import type { Pass } from "./registry.js";

const HOOK_ORDER = ["on_failure", "on_success", "on_abort", "ensure"] as const;
type HookKey = (typeof HOOK_ORDER)[number];

const BRANCH_KEYS = new Set<string>(["on_success", "on_failure", "on_abort"]);
const BRANCH_ORDER = ["on_success", "on_failure", "on_abort"] as const;

/** Lifecycle keys that may never appear nested inside another hook's step list. */
const NESTED_KEYS = ["on_failure", "on_success", "on_abort", "ensure", "finally"] as const;

const STATE_MAP: Record<string, string> = {
  failed: "failure",
  succeeded: "success",
  cancelled: "cancelled",
  skipped: "skipped",
};

function stepGuard(key: HookKey, id: string): string {
  switch (key) {
    case "on_failure":
      return `!cancelled() && steps.${id}.outcome == 'failure'`;
    case "on_success":
      return `success() && steps.${id}.outcome == 'success'`;
    case "on_abort":
      return "cancelled()";
    case "ensure":
      return "always()";
  }
}

function jobGuard(key: HookKey): string {
  switch (key) {
    case "on_failure":
      return "failure()";
    case "on_success":
      return "success()";
    case "on_abort":
      return "cancelled()";
    case "ensure":
      return "always()";
  }
}

/** Strip any lifecycle keys nested on a hook step (error #10) so they never emit. */
function stripNested(ctx: ParseContext, step: Step, path: Path): void {
  let found = false;
  for (const k of NESTED_KEYS) {
    if (step[k] !== undefined) {
      found = true;
      delete step[k];
    }
  }
  if (found) {
    pushDiagnostic(ctx, "error", "lifecycle hooks cannot nest", path, {
      code: "lifecycle-hook-nesting",
    });
  }
}

function applyGuard(step: Step, guard: string): void {
  const combined = combineIf(guard, step.if);
  if (combined) step.if = combined;
}

// ---------------------------------------------------------------------------
// Phase A — step & job modifiers (ensure / on_* on the same unit)
// ---------------------------------------------------------------------------

function expandStepHooks(
  ctx: ParseContext,
  jobId: string,
  step: Step,
  idx: number,
  used: Set<string>,
): Step[] {
  if (!isObject(step)) return [step];

  if (step.finally !== undefined) {
    pushDiagnostic(
      ctx,
      "error",
      "finally: is workflow-scoped; use ensure: for job/step teardown",
      ["jobs", jobId, "steps", idx, "finally"],
      { code: "lifecycle-finally-scope" },
    );
    delete step.finally;
  }

  const present = HOOK_ORDER.filter((k) => step[k] !== undefined);
  if (present.length === 0) return [step];

  const hookSteps: Step[] = [];
  let id: string | undefined;
  for (const key of HOOK_ORDER) {
    const value = step[key];
    if (value === undefined) continue;
    delete step[key];
    const path: Path = ["jobs", jobId, "steps", idx, key];
    if (!Array.isArray(value)) {
      pushDiagnostic(ctx, "error", `${key} must be a list of steps`, path, {
        code: "lifecycle-hook-not-steps",
      });
      continue;
    }
    if (value.length === 0) {
      pushDiagnostic(ctx, "warning", `empty ${key}: has no effect`, path, {
        code: "lifecycle-empty-hook",
      });
      continue;
    }
    if (key === "on_abort") {
      pushDiagnostic(
        ctx,
        "warning",
        "step-level on_abort only sees step cancellation; run-level cancel belongs in a workflow finally:",
        path,
        { code: "lifecycle-step-on-abort" },
      );
    }
    if (id === undefined) id = ensureStepId(step, used, `actio_${jobId}_step_${idx + 1}`);
    const guard = stepGuard(key, id);
    value.forEach((hook, j) => {
      const clone = deriveNode(ctx, step, cloneNode(ctx, hook as Step));
      stripNested(ctx, clone, [...path, j]);
      applyGuard(clone, guard);
      hookSteps.push(clone);
    });
  }
  return [step, ...hookSteps];
}

function processJobHooks(ctx: ParseContext, jobId: string, job: Job): void {
  if (job.finally !== undefined) {
    pushDiagnostic(
      ctx,
      "error",
      "finally: is workflow-scoped; use ensure: for job/step teardown",
      ["jobs", jobId, "finally"],
      { code: "lifecycle-finally-scope" },
    );
    delete job.finally;
  }

  const present = HOOK_ORDER.filter((k) => job[k] !== undefined);
  if (present.length === 0) return;

  if (typeof job.uses === "string") {
    for (const key of present) delete job[key];
    pushDiagnostic(
      ctx,
      "warning",
      `Job "${jobId}": ensure/on_* teardown is not supported on a reusable-workflow (uses) job; ignoring`,
      ["jobs", jobId],
      { code: "lifecycle-uses-job" },
    );
    return;
  }

  if (!Array.isArray(job.steps)) job.steps = [];
  for (const key of HOOK_ORDER) {
    const value = job[key];
    if (value === undefined) continue;
    delete job[key];
    const path: Path = ["jobs", jobId, key];
    if (!Array.isArray(value)) {
      pushDiagnostic(ctx, "error", `${key} must be a list of steps`, path, {
        code: "lifecycle-hook-not-steps",
      });
      continue;
    }
    if (value.length === 0) {
      pushDiagnostic(ctx, "warning", `empty ${key}: has no effect`, path, {
        code: "lifecycle-empty-hook",
      });
      continue;
    }
    const guard = jobGuard(key);
    value.forEach((hook, j) => {
      const clone = deriveNode(ctx, job, cloneNode(ctx, hook as Step));
      stripNested(ctx, clone, [...path, j]);
      applyGuard(clone, guard);
      (job.steps as Step[]).push(clone);
    });
  }
}

// ---------------------------------------------------------------------------
// Phase B — workflow-level finally:
// ---------------------------------------------------------------------------

interface FinallyCtx {
  jobs: Record<string, Job>;
  realJobs: string[];
  finallyNames: Set<string>;
  added: Set<string>;
  hasOnAbort: boolean;
}

/** Resolve a `when:` sugar string into a guard + the job it forces into needs. */
function resolveWhen(
  ctx: ParseContext,
  job: Job,
  name: string,
  c: FinallyCtx,
): { guard?: string; forceNeed?: string } {
  const raw = job.when;
  delete job.when;
  if (typeof raw !== "string") return {};
  const dot = raw.lastIndexOf(".");
  const jobRef = dot >= 0 ? raw.slice(0, dot) : raw;
  const state = dot >= 0 ? raw.slice(dot + 1) : "";
  if (dot < 0 || !c.realJobs.includes(jobRef)) {
    pushDiagnostic(ctx, "error", `Unknown job "${jobRef}" in when:`, ["finally", name, "when"], {
      code: "lifecycle-when-unknown-job",
      hint: `known jobs: ${c.realJobs.join(", ")}`,
    });
    return {};
  }
  const result = STATE_MAP[state];
  if (!result) {
    pushDiagnostic(
      ctx,
      "error",
      `Unknown outcome "${state}"; use failed / succeeded / cancelled / skipped`,
      ["finally", name, "when"],
      { code: "lifecycle-when-unknown-state" },
    );
    return {};
  }
  return { guard: `needs.${jobRef}.result == '${result}'`, forceNeed: jobRef };
}

/** Lift one author finally job into a real job; returns its computed needs. */
function liftJob(
  ctx: ParseContext,
  name: string,
  job: unknown,
  statusGuard: string,
  isAbort: boolean,
  c: FinallyCtx,
  path: Path,
): { job: Job; needs: string[] } | undefined {
  if (!isObject(job)) {
    pushDiagnostic(ctx, "error", `finally job "${name}" must be a mapping`, path, {
      code: "lifecycle-finally-not-mapping",
    });
    return undefined;
  }
  if (c.realJobs.includes(name) || c.added.has(name)) {
    pushDiagnostic(
      ctx,
      "error",
      `finally job "${name}" collides with a job of the same name`,
      path,
      { code: "lifecycle-job-collision" },
    );
    return undefined;
  }

  const { guard: whenGuard, forceNeed } = resolveWhen(ctx, job, name, c);

  const raw = job.needs;
  const authorNeeds = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  for (const dep of authorNeeds) {
    if (c.finallyNames.has(dep)) {
      pushDiagnostic(
        ctx,
        "error",
        "finally jobs cannot depend on each other in v1",
        [...path, "needs"],
        { code: "lifecycle-finally-needs-sibling" },
      );
    }
  }
  const cleaned = authorNeeds.filter((dep) => !c.finallyNames.has(dep));
  const add = forceNeed ? [...c.realJobs, forceNeed] : c.realJobs;
  const needs = mergeNeeds(cleaned, add);
  if (needs.length > 0) job.needs = needs;
  else delete job.needs;

  const guard = combineIf(statusGuard, whenGuard);
  if (guard) job.if = guard;

  if (isAbort && job["timeout-minutes"] === undefined) job["timeout-minutes"] = 5;

  c.jobs[name] = job;
  c.added.add(name);
  return { job, needs };
}

function processWorkflowFinally(ctx: ParseContext): void {
  const wf = workflow(ctx);
  const fin = wf.finally;
  delete wf.finally;
  if (fin === undefined) return;
  if (!isObject(fin)) {
    pushDiagnostic(ctx, "error", "finally must be a mapping of teardown jobs", ["finally"], {
      code: "lifecycle-finally-not-mapping",
    });
    return;
  }

  let jobs = wf.jobs as Record<string, Job> | undefined;
  if (!jobs || typeof jobs !== "object") {
    jobs = {};
    wf.jobs = jobs;
  }
  const realJobs = Object.keys(jobs).filter(
    (id) => !id.startsWith("actio_") && !id.startsWith("actio-"),
  );
  const hasOnAbort = Object.hasOwn(fin, "on_abort");

  const finallyNames = new Set<string>();
  for (const [key, value] of Object.entries(fin)) {
    if (BRANCH_KEYS.has(key)) {
      if (isObject(value)) for (const n of Object.keys(value)) finallyNames.add(n);
    } else {
      finallyNames.add(key);
    }
  }

  const c: FinallyCtx = { jobs, realJobs, finallyNames, added: new Set(), hasOnAbort };

  // Unconditional teardown jobs (everything not a branch key).
  for (const [name, value] of Object.entries(fin)) {
    if (BRANCH_KEYS.has(name)) continue;
    const companionSrc = hasOnAbort
      ? undefined
      : isObject(value)
        ? cloneNode(ctx, value)
        : undefined;
    const lifted = liftJob(ctx, name, value, "!cancelled()", false, c, ["finally", name]);
    if (!lifted || !companionSrc) continue;
    const compName = `${name}-on-cancel`;
    if (c.realJobs.includes(compName) || c.added.has(compName)) continue;
    delete companionSrc.when;
    if (lifted.needs.length > 0) companionSrc.needs = lifted.needs;
    else delete companionSrc.needs;
    companionSrc.if = "cancelled()";
    if (companionSrc["timeout-minutes"] === undefined) companionSrc["timeout-minutes"] = 5;
    jobs[compName] = companionSrc;
    c.added.add(compName);
  }

  // Branch groups: on_success / on_failure / on_abort.
  for (const branch of BRANCH_ORDER) {
    const value = fin[branch];
    if (value === undefined) continue;
    if (Array.isArray(value)) continue; // `on_abort: []` escape hatch (and empty branches).
    if (!isObject(value)) {
      pushDiagnostic(
        ctx,
        "error",
        `${branch} must be a mapping of teardown jobs`,
        ["finally", branch],
        {
          code: "lifecycle-finally-not-mapping",
        },
      );
      continue;
    }
    const status =
      branch === "on_success" ? "success()" : branch === "on_failure" ? "failure()" : "cancelled()";
    const isAbort = branch === "on_abort";
    for (const [name, jobMap] of Object.entries(value)) {
      liftJob(ctx, name, jobMap, status, isAbort, c, ["finally", branch, name]);
    }
  }
}

/**
 * lifecycle pass: lowers same-unit `ensure:`/`on_*:` modifiers into guarded
 * steps and the workflow-scoped `finally:` block into aggregator teardown jobs.
 * Runs after all job-multiplying passes so `needs:` covers every real job.
 */
export function lifecyclePass(ctx: ParseContext): void {
  visitJobs(ctx, ({ id: jobId, job }) => {
    if (Array.isArray(job.steps)) {
      const used = collectUsedStepIds(job.steps);
      transformSteps(ctx, jobId, job, (step, idx) => expandStepHooks(ctx, jobId, step, idx, used));
    }
    processJobHooks(ctx, jobId, job);
  });
  processWorkflowFinally(ctx);
}

export const lifecycle: Pass = {
  name: "lifecycle",
  runsAfter: ["fragments", "retry", "fallback", "dynamic_matrix", "for_each", "job_defaults"],
  apply: lifecyclePass,
};

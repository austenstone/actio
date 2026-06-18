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

/** Lifecycle hook modifier keys, in deterministic emission order. */
const HOOK_KEYS = ["on_failure", "on_success", "on_abort", "ensure"] as const;
type HookKey = (typeof HOOK_KEYS)[number];

const BRANCH_KEYS = new Set<string>(["on_success", "on_failure", "on_abort"]);

/**
 * actio-synthetic job ids (e.g. `actio_setup_*` from dynamic_matrix, `actio-annotate`
 * from annotate) are reserved with the `actio_` / `actio-` prefix and excluded from the
 * auto-`needs:` aggregation so finally jobs depend only on real, author-authored jobs.
 */
const SYNTHETIC_JOB_RE = /^actio[_-]/;

const WHEN_STATES: Record<string, string> = {
  failed: "failure",
  succeeded: "success",
  cancelled: "cancelled",
  skipped: "skipped",
};

/** Wrap a (possibly empty) combined condition as a GitHub `${{ }}` expression. */
function expr(condition: string): string {
  return `\${{ ${condition} }}`;
}

/** Guard parts for a step-scope hook (keyed on `outcome`, pre-continue-on-error). */
function stepGuard(key: HookKey, id: string | undefined): string[] {
  switch (key) {
    case "on_failure":
      return ["!cancelled()", `steps.${id}.outcome == 'failure'`];
    case "on_success":
      return ["success()", `steps.${id}.outcome == 'success'`];
    case "on_abort":
      return ["cancelled()"];
    case "ensure":
      return ["always()"];
  }
}

/** Guard for a job-scope hook (appended steps). */
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

/** Detect hook keys present on a node (for nesting error #10). */
function nestedHookKeys(node: unknown): HookKey[] {
  if (!isObject(node)) return [];
  return HOOK_KEYS.filter((k) => node[k] !== undefined);
}

/** Splice step-scope `ensure:`/`on_*:` hooks in immediately after each guarded step. */
function processStepHooks(ctx: ParseContext, jobId: string, job: Job): void {
  if (!Array.isArray(job.steps)) return;
  const used = collectUsedStepIds(job.steps);
  transformSteps(ctx, jobId, job, (step, idx) => {
    if (!isObject(step)) return [step];

    if (step.finally !== undefined) {
      pushDiagnostic(
        ctx,
        "error",
        "finally: is workflow-scoped; use ensure: for job/step teardown",
        ["jobs", jobId, "steps", idx, "finally"],
        { code: "lifecycle/finally-scope" },
      );
      delete step.finally;
    }

    const present = HOOK_KEYS.filter((k) => step[k] !== undefined);
    if (present.length === 0) return [step];

    const needsId = present.includes("on_failure") || present.includes("on_success");
    const id = needsId ? ensureStepId(step, used, `actio_${jobId}_step_${idx + 1}`) : undefined;

    const out: Step[] = [step];
    for (const key of HOOK_KEYS) {
      const raw = step[key];
      if (raw === undefined) continue;
      const path: Path = ["jobs", jobId, "steps", idx, key];

      if (key === "on_abort") {
        pushDiagnostic(
          ctx,
          "warning",
          "step-level on_abort only sees step cancellation; run-level cancel belongs in a workflow finally:",
          path,
          { code: "lifecycle/step-on-abort" },
        );
      }

      if (!Array.isArray(raw)) {
        pushDiagnostic(ctx, "error", `${key} must be a list of steps`, path, {
          code: "lifecycle/hook-shape",
        });
        delete step[key];
        continue;
      }
      if (raw.length === 0) {
        pushDiagnostic(ctx, "warning", `empty ${key}: has no effect`, path, {
          code: "lifecycle/empty-hook",
        });
        delete step[key];
        continue;
      }

      const guard = stepGuard(key, id);
      for (const hook of asStepArray(raw)) {
        const nested = nestedHookKeys(hook);
        if (nested.length > 0) {
          pushDiagnostic(ctx, "error", "lifecycle hooks cannot nest", path, {
            code: "lifecycle/nested-hook",
          });
          for (const k of nested) delete hook[k];
        }
        const clone = deriveNode(ctx, step, cloneNode(ctx, hook));
        const combined = combineIf(...guard, clone.if);
        if (combined) clone.if = expr(combined);
        else delete clone.if;
        out.push(clone);
      }
      delete step[key];
    }
    return out;
  });
}

/** Append job-scope `ensure:`/`on_*:` teardown steps to the end of the job. */
function processJobHooks(ctx: ParseContext, jobId: string, job: Job): void {
  const present = HOOK_KEYS.filter((k) => job[k] !== undefined);
  if (present.length === 0) return;

  if (typeof job.uses === "string") {
    for (const key of present) {
      pushDiagnostic(
        ctx,
        "warning",
        `Job "${jobId}": job-level ${key} is not supported on a reusable-workflow (uses) job; ignoring`,
        ["jobs", jobId, key],
        { code: "lifecycle/uses-job-hook" },
      );
      delete job[key];
    }
    return;
  }

  if (!Array.isArray(job.steps)) job.steps = [];
  for (const key of HOOK_KEYS) {
    const raw = job[key];
    if (raw === undefined) continue;
    const path: Path = ["jobs", jobId, key];

    if (!Array.isArray(raw)) {
      pushDiagnostic(ctx, "error", `${key} must be a list of steps`, path, {
        code: "lifecycle/hook-shape",
      });
      delete job[key];
      continue;
    }
    if (raw.length === 0) {
      pushDiagnostic(ctx, "warning", `empty ${key}: has no effect`, path, {
        code: "lifecycle/empty-hook",
      });
      delete job[key];
      continue;
    }

    const guard = jobGuard(key);
    for (const hook of asStepArray(raw)) {
      const nested = nestedHookKeys(hook);
      if (nested.length > 0) {
        pushDiagnostic(ctx, "error", "lifecycle hooks cannot nest", path, {
          code: "lifecycle/nested-hook",
        });
        for (const k of nested) delete hook[k];
      }
      const clone = deriveNode(ctx, job, cloneNode(ctx, hook));
      const combined = combineIf(guard, clone.if);
      if (combined) clone.if = expr(combined);
      else delete clone.if;
      (job.steps as Step[]).push(clone);
    }
    delete job[key];
  }
}

/** Resolve `when: <job>.<state>` sugar to a `needs.<job>.result ==` guard. */
function whenGuard(
  ctx: ParseContext,
  body: Job,
  realJobs: string[],
  path: Path,
): string | undefined {
  const raw = body.when;
  if (raw === undefined) return undefined;
  delete body.when;

  if (typeof raw !== "string") {
    pushDiagnostic(ctx, "error", "when: must be a string like <job>.failed", [...path, "when"], {
      code: "lifecycle/when-shape",
    });
    return undefined;
  }
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot >= raw.length - 1) {
    pushDiagnostic(
      ctx,
      "error",
      `Unknown outcome "${raw}"; use failed / succeeded / cancelled / skipped`,
      [...path, "when"],
      { code: "lifecycle/when-state" },
    );
    return undefined;
  }
  const jobRef = raw.slice(0, dot);
  const state = raw.slice(dot + 1);

  if (!realJobs.includes(jobRef)) {
    pushDiagnostic(ctx, "error", `Unknown job "${jobRef}" in when:`, [...path, "when"], {
      code: "lifecycle/when-job",
      hint: `known jobs: ${realJobs.join(", ")}`,
    });
    return undefined;
  }
  const result = WHEN_STATES[state];
  if (!result) {
    pushDiagnostic(
      ctx,
      "error",
      `Unknown outcome "${state}"; use failed / succeeded / cancelled / skipped`,
      [...path, "when"],
      { code: "lifecycle/when-state" },
    );
    return undefined;
  }
  return `needs.${jobRef}.result == '${result}'`;
}

/** Union author `needs:` with every real job, flagging sibling-finally edges (error #8). */
function finallyNeeds(
  ctx: ParseContext,
  body: Job,
  realJobs: string[],
  siblings: Set<string>,
  path: Path,
): string[] {
  const author = body.needs;
  const authorArr = typeof author === "string" ? [author] : Array.isArray(author) ? author : [];
  for (const n of authorArr) {
    if (siblings.has(n)) {
      pushDiagnostic(
        ctx,
        "error",
        "finally jobs cannot depend on each other in v1",
        [...path, "needs"],
        { code: "lifecycle/finally-needs-sibling" },
      );
      break;
    }
  }
  return mergeNeeds(author, realJobs);
}

/** Build a fresh teardown job with canonical key order (runs-on, needs, if, timeout, steps, …). */
function buildFinallyJob(
  ctx: ParseContext,
  body: Job,
  opts: { needs: string[]; ifGuard: string; timeout?: number },
): Job {
  const clone = cloneNode(ctx, body);
  const out: Job = {};
  if ("runs-on" in clone) out["runs-on"] = clone["runs-on"];
  out.needs = opts.needs;
  if (opts.ifGuard) out.if = opts.ifGuard;
  if (opts.timeout !== undefined) out["timeout-minutes"] = opts.timeout;

  const skip = new Set(["runs-on", "needs", "if", "timeout-minutes", "when", "steps"]);
  for (const [k, v] of Object.entries(clone)) {
    if (skip.has(k)) continue;
    out[k] = v;
  }
  if ("steps" in clone) out.steps = clone.steps;
  return deriveNode(ctx, body, out);
}

/** Lift `ctx.data.finally` into real aggregator jobs that auto-`needs:` every job. */
function liftFinally(ctx: ParseContext): void {
  const wf = workflow(ctx);
  const fin = wf.finally;
  if (fin === undefined) return;

  if (
    !expectMapping(ctx, fin, ["finally"], {
      message: "finally must be a mapping of teardown jobs",
      code: "lifecycle/finally-not-mapping",
    })
  ) {
    delete wf.finally;
    return;
  }

  const jobs = wf.jobs;
  if (!isObject(jobs)) {
    delete wf.finally;
    return;
  }

  const realJobs = Object.keys(jobs).filter((k) => !SYNTHETIC_JOB_RE.test(k));
  const hasOnAbort = Object.hasOwn(fin, "on_abort");

  // Every job name `finally:` will emit, for sibling-dependency detection (error #8).
  const siblings = new Set<string>();
  for (const [key, val] of Object.entries(fin)) {
    if (BRANCH_KEYS.has(key)) {
      if (isObject(val)) for (const name of Object.keys(val)) siblings.add(name);
    } else {
      siblings.add(key);
      if (!hasOnAbort) siblings.add(`${key}-on-cancel`);
    }
  }

  const emit = (name: string, job: Job, path: Path): void => {
    if (Object.hasOwn(jobs, name)) {
      pushDiagnostic(
        ctx,
        "error",
        `finally job "${name}" collides with a job of the same name`,
        path,
        { code: "lifecycle/finally-collision" },
      );
      return;
    }
    jobs[name] = job;
  };

  // Direct (unconditional) teardown jobs: normal-path aggregator + auto cancel companion.
  for (const [key, val] of Object.entries(fin)) {
    if (BRANCH_KEYS.has(key)) continue;
    if (
      !expectMapping(ctx, val, ["finally", key], {
        message: `finally job "${key}" must be a mapping`,
        code: "lifecycle/finally-job-shape",
      })
    ) {
      continue;
    }
    const body = val as Job;
    const path: Path = ["finally", key];
    const guard = whenGuard(ctx, body, realJobs, path);
    const needs = finallyNeeds(ctx, body, realJobs, siblings, path);

    emit(
      key,
      buildFinallyJob(ctx, body, { needs, ifGuard: expr(combineIf("!cancelled()", guard)) }),
      path,
    );

    if (!hasOnAbort) {
      const timeout = (body["timeout-minutes"] as number | undefined) ?? 5;
      emit(
        `${key}-on-cancel`,
        buildFinallyJob(ctx, body, {
          needs: [...needs],
          ifGuard: expr(combineIf("cancelled()", guard)),
          timeout,
        }),
        path,
      );
    }
  }

  // Outcome-branch teardown jobs (on_success / on_failure / on_abort).
  for (const [key, val] of Object.entries(fin)) {
    if (!BRANCH_KEYS.has(key)) continue;
    const status =
      key === "on_success" ? "success()" : key === "on_failure" ? "failure()" : "cancelled()";

    // `on_abort: []` (empty) is the escape hatch: zero cancel jobs.
    if (Array.isArray(val)) {
      if (val.length > 0) {
        pushDiagnostic(
          ctx,
          "error",
          `${key} must be a mapping of teardown jobs`,
          ["finally", key],
          {
            code: "lifecycle/branch-shape",
          },
        );
      }
      continue;
    }
    if (!isObject(val)) {
      pushDiagnostic(ctx, "error", `${key} must be a mapping of teardown jobs`, ["finally", key], {
        code: "lifecycle/branch-shape",
      });
      continue;
    }

    for (const [jobId, jobVal] of Object.entries(val)) {
      const path: Path = ["finally", key, jobId];
      if (
        !expectMapping(ctx, jobVal, path, {
          message: `finally job "${jobId}" must be a mapping`,
          code: "lifecycle/finally-job-shape",
        })
      ) {
        continue;
      }
      const body = jobVal as Job;
      const guard = whenGuard(ctx, body, realJobs, path);
      const needs = finallyNeeds(ctx, body, realJobs, siblings, path);
      const timeout =
        key === "on_abort"
          ? ((body["timeout-minutes"] as number | undefined) ?? 5)
          : (body["timeout-minutes"] as number | undefined);
      emit(
        jobId,
        buildFinallyJob(ctx, body, { needs, ifGuard: expr(combineIf(status, guard)), timeout }),
        path,
      );
    }
  }

  delete wf.finally;
}

/**
 * lifecycle pass: lowers the teardown family.
 * - step `ensure:`/`on_*:` => guard steps spliced after the step (keyed on `outcome`).
 * - job  `ensure:`/`on_*:` => teardown steps appended to the job, status-guarded.
 * - workflow `finally:`     => real aggregator jobs that auto-`needs:` every real job,
 *   with a split `!cancelled()` + `cancelled()` companion (no bare `always()` at job scope).
 */
export function lifecyclePass(ctx: ParseContext): void {
  visitJobs(ctx, ({ id, job }) => {
    if (job.finally !== undefined) {
      pushDiagnostic(
        ctx,
        "error",
        "finally: is workflow-scoped; use ensure: for job/step teardown",
        ["jobs", id, "finally"],
        { code: "lifecycle/finally-scope" },
      );
      delete job.finally;
    }
    processStepHooks(ctx, id, job);
    processJobHooks(ctx, id, job);
  });

  liftFinally(ctx);
}

/** Lower the lifecycle teardown family (ensure/finally/on_*). */
export const lifecycle: Pass = {
  name: "lifecycle",
  runsAfter: ["fragments", "retry", "fallback", "dynamic_matrix", "for_each", "job_defaults"],
  apply: lifecyclePass,
};

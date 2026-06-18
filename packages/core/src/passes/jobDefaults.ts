import { type Job, visitJobs } from "../ir.js";
import type { ParseContext } from "../parser.js";
import { combineIf, isObject, pushDiagnostic } from "./helpers.js";
import type { Pass } from "./registry.js";

const CALL_JOB_DEFAULT_KEYS = new Set(["if", "permissions", "strategy", "concurrency"]);
const REPLACE_ON_PRESENCE_KEYS = new Set(["permissions", "concurrency"]);
const EXECUTOR_KEYS = ["runs-on", "container", "services", "env"] as const;

type ExecutorKey = (typeof EXECUTOR_KEYS)[number];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function asMap(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out = clone(base);
  for (const [key, overValue] of Object.entries(over)) {
    const baseValue = out[key];
    if (isObject(baseValue) && isObject(overValue)) {
      out[key] = deepMerge(baseValue, overValue);
      continue;
    }
    out[key] = clone(overValue);
  }
  return out;
}

function mergeDefaultValue(key: string, inherited: unknown, current: unknown): unknown {
  if (key === "if") {
    return combineIf(inherited as string | boolean | number, current as string | boolean | number);
  }
  if (REPLACE_ON_PRESENCE_KEYS.has(key)) {
    return current === undefined ? clone(inherited) : current;
  }
  if (current === undefined) return clone(inherited);
  if (isObject(inherited) && isObject(current)) return deepMerge(inherited, current);
  return current;
}

function applyDefaults(
  job: Job,
  defaults: Record<string, unknown>,
  allowedKeys?: Set<string>,
): string[] {
  const skipped: string[] = [];
  for (const [key, inherited] of Object.entries(defaults)) {
    if (allowedKeys && !allowedKeys.has(key)) {
      skipped.push(key);
      continue;
    }
    const merged = mergeDefaultValue(key, inherited, job[key]);
    if (key === "if") {
      if (typeof merged === "string" && merged.length > 0) job.if = merged;
      else delete job.if;
      continue;
    }
    job[key] = merged;
  }
  return skipped;
}

function getExecutorTemplate(ctx: ParseContext): Record<string, Record<string, unknown>> {
  const raw = ctx.data.executors;
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    pushDiagnostic(ctx, "error", '"executors" must be a mapping', ["executors"]);
    return {};
  }

  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isObject(value)) {
      pushDiagnostic(ctx, "error", `Executor "${name}" must be a mapping`, ["executors", name]);
      continue;
    }
    out[name] = value;
  }
  return out;
}

function applyExecutor(
  job: Job,
  executor: Record<string, unknown>,
  inlineKeys: Record<ExecutorKey, boolean>,
) {
  for (const key of EXECUTOR_KEYS) {
    const incoming = executor[key];
    if (incoming === undefined || inlineKeys[key]) continue;
    const current = job[key];
    if (isObject(current) && isObject(incoming)) {
      job[key] = deepMerge(current, incoming) as Job[ExecutorKey];
      continue;
    }
    job[key] = clone(incoming) as Job[ExecutorKey];
  }
}

function isReusableCallJob(job: Job): boolean {
  return typeof job.uses === "string" && job.uses.length > 0;
}

/**
 * Apply top-level `job_defaults` and `executors` to jobs.
 *
 * Locked semantics:
 * - partition first: `uses` jobs only get call-compatible defaults
 * - `if` combines with `&&` (never replaced)
 * - permissions/concurrency are replace-on-presence
 * - executors expand runner keys; job inline runner keys win
 */
export function jobDefaultsPass(ctx: ParseContext): void {
  const defaults = asMap(ctx.data.job_defaults);
  if (ctx.data.job_defaults !== undefined && !defaults) {
    pushDiagnostic(ctx, "error", '"job_defaults" must be a mapping', ["job_defaults"]);
  }
  const executors = getExecutorTemplate(ctx);
  const availableExecutors = Object.keys(executors);

  visitJobs(ctx, ({ id: jobId, job }) => {
    const usesJob = isReusableCallJob(job);
    const inlineKeys: Record<ExecutorKey, boolean> = {
      "runs-on": Object.hasOwn(job, "runs-on"),
      container: Object.hasOwn(job, "container"),
      services: Object.hasOwn(job, "services"),
      env: Object.hasOwn(job, "env"),
    };

    if (defaults) {
      const skipped = usesJob
        ? applyDefaults(job, defaults, CALL_JOB_DEFAULT_KEYS)
        : applyDefaults(job, defaults);
      if (usesJob && skipped.length > 0) {
        pushDiagnostic(
          ctx,
          "info",
          `[job-defaults-uses-skipped] Job "${jobId}" skipped non-call-compatible job_defaults keys: ${skipped.join(", ")}`,
          ["jobs", jobId, "uses"],
        );
      }
    }

    const rawExecutor = job.executor;
    if (rawExecutor === undefined) return;
    delete job.executor;

    if (usesJob) {
      pushDiagnostic(
        ctx,
        "error",
        `Job "${jobId}": "executor" is not supported on reusable-workflow call jobs`,
        ["jobs", jobId, "executor"],
      );
      return;
    }

    if (typeof rawExecutor !== "string" || rawExecutor.trim().length === 0) {
      pushDiagnostic(ctx, "error", `Job "${jobId}": executor must be a non-empty string`, [
        "jobs",
        jobId,
        "executor",
      ]);
      return;
    }

    const executorName = rawExecutor.trim();
    const executor = executors[executorName];
    if (!executor) {
      pushDiagnostic(
        ctx,
        "error",
        `[executor-unknown] Job "${jobId}" references unknown executor "${executorName}"`,
        ["jobs", jobId, "executor"],
        {
          hint:
            availableExecutors.length > 0
              ? `Available executors: ${availableExecutors.join(", ")}`
              : 'Define top-level "executors:" entries before using "executor:"',
        },
      );
      return;
    }

    applyExecutor(job, executor, inlineKeys);
  });

  delete ctx.data.job_defaults;
  delete ctx.data.executors;
}

export const jobDefaults: Pass = {
  name: "job_defaults",
  runsAfter: ["params"],
  apply: jobDefaultsPass,
};

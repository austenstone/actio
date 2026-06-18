import { type Job, visitJobs } from "../ir.js";
import type { ParseContext } from "../parser.js";
import { clone, combineIf, isObject, pushDiagnostic } from "./helpers.js";
import type { Pass } from "./registry.js";

const JOB_DEFAULT_KEYS = [
  "if",
  "permissions",
  "concurrency",
  "strategy",
  "timeout-minutes",
  "runs-on",
  "env",
  "container",
  "services",
  "defaults",
] as const;

type JobDefaultKey = (typeof JOB_DEFAULT_KEYS)[number];

const EXECUTOR_KEYS = JOB_DEFAULT_KEYS.filter(
  (key): key is Exclude<JobDefaultKey, "if"> => key !== "if",
);

const CALL_JOB_DEFAULT_KEYS = new Set<string>(["if", "permissions", "concurrency", "strategy"]);
const REPLACE_ON_PRESENCE_KEYS = new Set(["permissions", "concurrency"]);
const REPLACE_KEYS = new Set(["runs-on", "timeout-minutes"]);
const REJECTED_TEMPLATE_KEYS = new Set([
  "steps",
  "needs",
  "uses",
  "with",
  "secrets",
  "name",
  "outputs",
]);
const MACRO_KEYS = new Set([
  "inject",
  "retry",
  "fallback",
  "dynamic_matrix",
  "for_each",
  "executor",
]);

export const JOB_DEFAULTS_SAFE_SUBSET = new Set<string>([
  "if",
  "permissions",
  "concurrency",
  "env",
  "timeout-minutes",
]);

type ExecutorKey = (typeof EXECUTOR_KEYS)[number];
type InlinePresence = Record<JobDefaultKey | ExecutorKey, boolean>;

const EXECUTOR_KEY_SET = new Set<string>(EXECUTOR_KEYS);

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
  if (current !== undefined && REPLACE_KEYS.has(key)) {
    return current;
  }
  if (current === undefined) return clone(inherited);
  if (isObject(inherited) && isObject(current)) return deepMerge(inherited, current);
  return current;
}

export function applyDefaults(
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

function mergeExecutorValue(key: string, current: unknown, incoming: unknown): unknown {
  if (REPLACE_ON_PRESENCE_KEYS.has(key) || REPLACE_KEYS.has(key)) {
    return clone(incoming);
  }
  if (isObject(current) && isObject(incoming)) {
    return deepMerge(current, incoming);
  }
  return clone(incoming);
}

function isExecutorKey(key: string): key is ExecutorKey {
  return EXECUTOR_KEY_SET.has(key);
}

function composeExecutors(
  executorNames: string[],
  executors: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  let composed: Record<string, unknown> = {};
  for (const executorName of executorNames) {
    const executor = executors[executorName];
    if (!executor) continue;
    const next = clone(composed);
    for (const [key, value] of Object.entries(executor)) {
      next[key] = mergeExecutorValue(key, next[key], value);
    }
    composed = next;
  }
  return composed;
}

export function applyExecutor(
  job: Job,
  executor: Record<string, unknown>,
  inlineKeys: Partial<Record<JobDefaultKey | ExecutorKey, boolean>> = {},
): void {
  const writableJob = job as Record<string, unknown>;
  for (const [key, incoming] of Object.entries(executor)) {
    if (!isExecutorKey(key)) continue;
    if (incoming === undefined || inlineKeys[key]) continue;
    writableJob[key] = mergeExecutorValue(key, writableJob[key], incoming);
  }
}

function isReusableCallJob(job: Job): boolean {
  return typeof job.uses === "string" && job.uses.length > 0;
}

function preserveRawTemplates(ctx: ParseContext): void {
  const rawJobDefaults = asMap(ctx.data.job_defaults);
  const rawExecutors = asMap(ctx.data.executors);
  ctx.internal.jobDefaults = {
    jobDefaults: rawJobDefaults ? clone(rawJobDefaults) : undefined,
    executors: rawExecutors ? clone(rawExecutors) : undefined,
  };
}

function validateTemplateKey(
  ctx: ParseContext,
  key: string,
  path: (string | number)[],
  allowedKeys: Set<string>,
  code: string,
): boolean {
  if (allowedKeys.has(key)) return true;
  const message =
    REJECTED_TEMPLATE_KEYS.has(key) || MACRO_KEYS.has(key)
      ? `[${code}] Key "${key}" is not allowed here`
      : `[${code}] Key "${key}" is not supported here`;
  pushDiagnostic(ctx, "error", message, path, {
    hint: `Allowed keys: ${[...allowedKeys].join(", ")}`,
  });
  return false;
}

function validateJobDefaults(ctx: ParseContext): Record<string, unknown> | undefined {
  const raw = ctx.data.job_defaults;
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    pushDiagnostic(ctx, "error", '"job_defaults" must be a mapping', ["job_defaults"]);
    return undefined;
  }
  const allowed = new Set<string>(JOB_DEFAULT_KEYS);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      !validateTemplateKey(ctx, key, ["job_defaults", key], allowed, "job-defaults-rejected-key")
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function getExecutorTemplate(ctx: ParseContext): Record<string, Record<string, unknown>> {
  const raw = ctx.data.executors;
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    pushDiagnostic(ctx, "error", '"executors" must be a mapping', ["executors"]);
    return {};
  }

  const allowed = new Set<string>(EXECUTOR_KEYS);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isObject(value)) {
      pushDiagnostic(ctx, "error", `Executor "${name}" must be a mapping`, ["executors", name]);
      continue;
    }
    const executor: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (
        !validateTemplateKey(ctx, key, ["executors", name, key], allowed, "executor-rejected-key")
      ) {
        continue;
      }
      executor[key] = field;
    }
    out[name] = executor;
  }
  return out;
}

function parseExecutorRefs(
  ctx: ParseContext,
  jobId: string,
  rawExecutor: unknown,
): string[] | undefined {
  if (typeof rawExecutor === "string") {
    const executor = rawExecutor.trim();
    if (executor.length > 0) return [executor];
    pushDiagnostic(ctx, "error", `Job "${jobId}": executor must be a non-empty string`, [
      "jobs",
      jobId,
      "executor",
    ]);
    return undefined;
  }

  if (!Array.isArray(rawExecutor)) {
    pushDiagnostic(ctx, "error", `Job "${jobId}": executor must be a string or list of strings`, [
      "jobs",
      jobId,
      "executor",
    ]);
    return undefined;
  }

  const refs: string[] = [];
  let valid = true;
  rawExecutor.forEach((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      valid = false;
      pushDiagnostic(ctx, "error", `Job "${jobId}": executor entries must be non-empty strings`, [
        "jobs",
        jobId,
        "executor",
        index,
      ]);
      return;
    }
    refs.push(value.trim());
  });
  return valid ? refs : undefined;
}

function collectInlineKeys(job: Job): InlinePresence {
  const out: InlinePresence = {} as InlinePresence;
  for (const key of EXECUTOR_KEYS) {
    out[key] = Object.hasOwn(job, key);
  }
  return out;
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
  preserveRawTemplates(ctx);
  const defaults = validateJobDefaults(ctx);
  const executors = getExecutorTemplate(ctx);
  const availableExecutors = Object.keys(executors);

  visitJobs(ctx, ({ id: jobId, job }) => {
    const usesJob = isReusableCallJob(job);
    const inlineKeys = collectInlineKeys(job);

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

    const executorRefs = parseExecutorRefs(ctx, jobId, rawExecutor);
    if (!executorRefs) return;

    const missing = executorRefs.find((name) => !executors[name]);
    if (missing) {
      pushDiagnostic(
        ctx,
        "error",
        `[executor-unknown] Job "${jobId}" references unknown executor "${missing}"`,
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

    const composed = composeExecutors(
      executorRefs,
      executors as Record<string, Record<string, unknown>>,
    );
    applyExecutor(job, composed, inlineKeys);
  });

  delete ctx.data.job_defaults;
  delete ctx.data.executors;
}

export const jobDefaults: Pass = {
  name: "job_defaults",
  runsAfter: ["params"],
  apply: jobDefaultsPass,
};

import {
  cloneNode,
  deriveNode,
  type Job,
  originOf,
  type Step,
  transformSteps,
  visitJobs,
} from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import {
  asStepArray,
  collectUsedStepIds,
  combineIf,
  isObject,
  mapFallbackSteps,
  pushDiagnostic,
  slugify,
} from "./helpers.js";
import type { Pass } from "./registry.js";

const DEFAULT_ATTEMPTS = 3;

interface NormalizedRetry {
  attempts: number;
  delaySeconds?: number;
  delayLabel?: string;
}

function formatRetryValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function reserveUsedStepIds(used: Set<string>, steps: Step[] | undefined): void {
  for (const id of collectUsedStepIds(steps)) used.add(id);
}

function reserveFallbackStepIds(used: Set<string>, container: { fallback?: unknown }): void {
  const fallback = container.fallback;
  if (Array.isArray(fallback)) {
    reserveUsedStepIds(used, asStepArray(fallback));
  } else if (isObject(fallback) && Array.isArray(fallback.steps)) {
    reserveUsedStepIds(used, asStepArray(fallback.steps));
  }
}

/** Parse a `delay` value ("10s" | "2m" | "1h" | number-of-seconds) into seconds. */
function parseDelaySeconds(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 ? value : undefined;
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
    const amount = m?.[1];
    if (!amount) return undefined;
    const n = Number.parseFloat(amount);
    if (!(n > 0)) return undefined;
    const unit = (m[2] ?? "s").toLowerCase();
    const mult = unit === "h" ? 3600 : unit === "m" ? 60 : 1;
    return n * mult;
  }
  return undefined;
}

const RETRY_KEYS = new Set(["attempts", "delay"]);

/**
 * Normalize and validate a `retry:` value. Malformed shapes emit a diagnostic
 * (anchored at `path` when known) and return `null` so the caller leaves the
 * step untouched, rather than silently dropping the macro.
 */
function normalizeRetry(ctx: ParseContext, raw: unknown, path?: Path): NormalizedRetry | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 2) {
      pushDiagnostic(
        ctx,
        "warning",
        `retry attempts must be a number >= 2 (got ${formatRetryValue(raw)}); ignoring retry`,
        path,
        { hint: "use `retry: 3` or `retry: { attempts: 3 }`" },
      );
      return null;
    }
    return { attempts: Math.floor(raw) };
  }
  if (isObject(raw)) {
    for (const key of Object.keys(raw)) {
      if (!RETRY_KEYS.has(key)) {
        pushDiagnostic(
          ctx,
          "warning",
          `retry has unknown key "${key}"; supported keys are attempts, delay`,
          path ? [...path, key] : undefined,
        );
      }
    }
    const attemptsRaw = (raw as Step).attempts;
    let attempts = DEFAULT_ATTEMPTS;
    if (attemptsRaw !== undefined) {
      if (typeof attemptsRaw !== "number" || !Number.isFinite(attemptsRaw)) {
        pushDiagnostic(
          ctx,
          "warning",
          `retry.attempts must be a number (got ${formatRetryValue(attemptsRaw)}); ignoring retry`,
          path ? [...path, "attempts"] : path,
        );
        return null;
      }
      if (attemptsRaw < 2) {
        pushDiagnostic(
          ctx,
          "warning",
          `retry.attempts must be >= 2 (got ${attemptsRaw}); ignoring retry`,
          path ? [...path, "attempts"] : path,
        );
        return null;
      }
      attempts = Math.floor(attemptsRaw);
    }
    const delayRaw = (raw as Step).delay;
    const delaySeconds = parseDelaySeconds(delayRaw);
    if (delayRaw !== undefined && delaySeconds == null) {
      pushDiagnostic(
        ctx,
        "warning",
        `retry.delay ${JSON.stringify(delayRaw)} is not a positive duration (e.g. "10s", "2m", "1h", or seconds); ignoring delay`,
        path ? [...path, "delay"] : path,
      );
    }
    const delayLabel =
      typeof delayRaw === "string" && delaySeconds != null
        ? delayRaw.trim()
        : delaySeconds != null
          ? `${delaySeconds}s`
          : undefined;
    return { attempts, delaySeconds, delayLabel };
  }
  pushDiagnostic(
    ctx,
    "warning",
    `retry must be a number or a mapping (got ${raw === null ? "null" : typeof raw}); ignoring retry`,
    path,
    { hint: 'use `retry: 3` or `retry: { attempts: 3, delay: "10s" }`' },
  );
  return null;
}

/** Human label for a step, used to auto-name retry attempts. */
function stepLabel(step: Step): string {
  if (typeof step.name === "string" && step.name.trim()) return step.name.trim();
  if (typeof step.uses === "string" && step.uses.trim()) return step.uses.trim();
  if (typeof step.run === "string") {
    const first = step.run.split("\n")[0]?.trim();
    if (first) return first.length > 40 ? `${first.slice(0, 37)}...` : first;
  }
  return "step";
}

/** Build the fan-out chain of attempts for a single `retry:` step. */
function buildRetryAttempts(
  ctx: ParseContext,
  jobId: string,
  step: Step,
  idx: number,
  used: Set<string>,
  cfg: NormalizedRetry,
  sourcePath?: Path,
): Step[] {
  const label = stepLabel(step);
  const slug = slugify(label);
  const base = slug ? `step_${slug}` : `actio_${jobId}_step_${idx + 1}`;
  const idPath: Path = sourcePath ? [...sourcePath, "id"] : ["jobs", jobId, "steps", idx, "id"];
  // A user-supplied `id` is reclaimed onto the FINAL attempt only. That attempt
  // is gated on the prior attempt FAILING, so on the common first-attempt-success
  // path it (and the reclaimed id) is skipped — downstream `steps.<id>.outputs`
  // and `.outcome` then read empty. Native GHA can't express "id of whichever
  // attempt ran", so warn about the hazard rather than corrupt silently.
  const userId = typeof step.id === "string" && step.id.trim() ? step.id.trim() : undefined;
  if (userId) {
    pushDiagnostic(
      ctx,
      "warning",
      `Step "${userId}" in job "${jobId}": retry reclaims this id onto the final attempt, ` +
        `which only runs after an earlier attempt fails; downstream ` +
        `steps.${userId}.outputs/.outcome are empty on first-attempt success`,
      idPath,
    );
  }
  // Keep `userId` reserved in `used` so a synthesized `${base}_attempt_${n}` can
  // never claim that exact value (the `while (used.has(id))` guard below skips
  // it); the final attempt then reclaims it as a unique id.
  if (userId) used.add(userId);
  // Preserve a falsy boolean/number `if` (e.g. `if: false` / `if: 0`) — both
  // are valid "never run" gates that must survive onto the first attempt.
  const originalIf =
    typeof step.if === "string" || typeof step.if === "boolean" || typeof step.if === "number"
      ? step.if
      : undefined;
  const { attempts, delaySeconds, delayLabel } = cfg;
  const out: Step[] = [];

  let prevId: string | undefined;
  for (let n = 1; n <= attempts; n++) {
    const isLast = n === attempts;
    const guard = prevId ? `steps.${prevId}.outcome == 'failure'` : undefined;
    // The first attempt (no guard) carries the user's gate verbatim so a falsy
    // boolean/number `if` stays a real boolean and keeps the step disabled.
    const condition: string | boolean | number | undefined =
      guard == null && typeof originalIf !== "string" ? originalIf : combineIf(originalIf, guard);

    if (delaySeconds != null && prevId) {
      const sleepStep: Step = deriveNode(ctx, step, {
        name: `Retry backoff (${delayLabel ?? `${delaySeconds}s`}) before attempt ${n}/${attempts}`,
        run: `sleep ${delaySeconds}`,
      });
      if (condition !== undefined && condition !== "") sleepStep.if = condition as string;
      out.push(sleepStep);
    }

    const attempt = cloneNode(ctx, step);
    attempt.name = `${label} (attempt ${n}/${attempts})`;
    let id: string;
    if (isLast && userId) {
      id = userId;
    } else {
      id = `${base}_attempt_${n}`;
      let dedupe = 2;
      while (used.has(id)) id = `${base}_attempt_${n}_${dedupe++}`;
    }
    used.add(id);
    attempt.id = id;

    if (condition !== undefined && condition !== "") {
      attempt.if = condition as string;
    } else {
      delete attempt.if;
    }

    // Every attempt but the last swallows failure so the next can run. The last
    // attempt keeps the original `continue-on-error` (default: fail the job).
    if (!isLast) {
      attempt["continue-on-error"] = true;
      // Defer any fallback to the final attempt only.
      delete attempt.fallback;
    }

    out.push(attempt);
    prevId = id;
  }
  return out;
}

/** Expand `retry:` keys in a plain step list, recursing into nested fallbacks. */
function expandRetryInList(
  ctx: ParseContext,
  jobId: string,
  steps: Step[],
  used: Set<string>,
): Step[] {
  reserveUsedStepIds(used, steps);
  const out: Step[] = [];
  steps.forEach((step, idx) => {
    const sourcePath = isObject(step) ? originOf(ctx, step)?.path : undefined;
    if (isObject(step) && step.fallback != null) expandRetryInFallback(ctx, jobId, step, used);
    if (!isObject(step) || step.retry == null) {
      out.push(step);
      return;
    }
    const cfg = normalizeRetry(ctx, step.retry, sourcePath ? [...sourcePath, "retry"] : undefined);
    delete step.retry;
    if (cfg == null) {
      out.push(step);
      return;
    }
    out.push(...buildRetryAttempts(ctx, jobId, step, idx, used, cfg, sourcePath));
  });
  return out;
}

/** Recurse into a step- or job-level `fallback` block so nested `retry:` expands. */
function expandRetryInFallback(
  ctx: ParseContext,
  jobId: string,
  container: Step | Job,
  used: Set<string>,
): void {
  mapFallbackSteps(container, (steps) => expandRetryInList(ctx, jobId, steps, used));
}

/** Expand step-level `retry:` blocks into a chain of conditional attempts. */
function processStepRetries(ctx: ParseContext, jobId: string, job: Job): void {
  const used = collectUsedStepIds(Array.isArray(job.steps) ? job.steps : []);
  reserveFallbackStepIds(used, job);
  if (Array.isArray(job.steps)) {
    transformSteps(ctx, jobId, job, (step, idx) => {
      const sourcePath = isObject(step)
        ? (originOf(ctx, step)?.path ?? ["jobs", jobId, "steps", idx])
        : undefined;
      if (isObject(step) && step.fallback != null) expandRetryInFallback(ctx, jobId, step, used);
      if (!isObject(step) || step.retry == null) return [step];
      const cfg = normalizeRetry(
        ctx,
        step.retry,
        sourcePath ? [...sourcePath, "retry"] : undefined,
      );
      delete step.retry;
      if (cfg == null) return [step];
      return buildRetryAttempts(ctx, jobId, step, idx, used, cfg, sourcePath);
    });
  }
  // A job-level `fallback` may itself contain steps carrying `retry:`.
  if (job.fallback != null) expandRetryInFallback(ctx, jobId, job, used);
}

/**
 * retry pass: expands a step-level `retry:` block into a fan-out chain of
 * attempts. Each attempt but the last gets `continue-on-error: true`; attempt
 * `n` runs only when attempt `n-1` had `outcome == 'failure'`, so a success
 * short-circuits the rest and an all-fail run fails the job on the final
 * attempt. Optional `delay` injects `sleep` backoff steps between attempts.
 *
 * Runs before `fallback` so a step carrying both keys retries first, then its
 * fallback (preserved only on the final attempt) wires up normally.
 */
export function retryPass(ctx: ParseContext): void {
  visitJobs(ctx, ({ id: jobId, job }) => {
    if (job.retry != null) {
      pushDiagnostic(
        ctx,
        "warning",
        `Job "${jobId}": retry is only supported on steps, not jobs; ignoring`,
        ["jobs", jobId, "retry"],
      );
      delete job.retry;
    }
    processStepRetries(ctx, jobId, job);
  });
}

/** Fan out retry attempts before fallback wraps the final attempt. */
export const retry: Pass = { name: "retry", runsAfter: ["fragments", "share"], apply: retryPass };

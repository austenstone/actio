import { type Job, type Step, cloneNode, deriveNode, transformSteps, visitJobs } from "../ir.js";
import type { ParseContext } from "../parser.js";
import { collectUsedStepIds, combineIf, isObject, pushDiagnostic, slugify } from "./helpers.js";
import type { Pass } from "./registry.js";

const DEFAULT_ATTEMPTS = 3;

interface NormalizedRetry {
  attempts: number;
  delaySeconds?: number;
  delayLabel?: string;
}

/** Parse a `delay` value ("10s" | "2m" | "1h" | number-of-seconds) into seconds. */
function parseDelaySeconds(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 ? value : undefined;
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
    if (!m) return undefined;
    const n = Number.parseFloat(m[1]);
    if (!(n > 0)) return undefined;
    const unit = (m[2] ?? "s").toLowerCase();
    const mult = unit === "h" ? 3600 : unit === "m" ? 60 : 1;
    return n * mult;
  }
  return undefined;
}

function normalizeRetry(raw: unknown): NormalizedRetry | null {
  if (typeof raw === "number") {
    return raw >= 2 ? { attempts: Math.floor(raw) } : null;
  }
  if (isObject(raw)) {
    const attemptsRaw = (raw as Step).attempts;
    const attempts =
      typeof attemptsRaw === "number" && attemptsRaw >= 1
        ? Math.floor(attemptsRaw)
        : DEFAULT_ATTEMPTS;
    if (attempts < 2) return null;
    const delaySeconds = parseDelaySeconds((raw as Step).delay);
    const delayLabel =
      typeof (raw as Step).delay === "string"
        ? ((raw as Step).delay as string).trim()
        : delaySeconds != null
          ? `${delaySeconds}s`
          : undefined;
    return { attempts, delaySeconds, delayLabel };
  }
  return null;
}

/** Human label for a step, used to auto-name retry attempts. */
function stepLabel(step: Step): string {
  if (typeof step.name === "string" && step.name.trim()) return step.name.trim();
  if (typeof step.uses === "string" && step.uses.trim()) return step.uses.trim();
  if (typeof step.run === "string") {
    const first = step.run.split("\n")[0].trim();
    if (first) return first.length > 40 ? `${first.slice(0, 37)}...` : first;
  }
  return "step";
}

function formatSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : String(seconds);
}

/** Expand step-level `retry:` blocks into a chain of conditional attempts. */
function processStepRetries(ctx: ParseContext, jobId: string, job: Job): void {
  if (!Array.isArray(job.steps)) return;
  const used = collectUsedStepIds(job.steps);

  transformSteps(ctx, jobId, job, (step, idx) => {
    if (!isObject(step) || step.retry == null) return [step];
    const cfg = normalizeRetry(step.retry);
    delete step.retry;
    if (cfg == null) return [step];

    const label = stepLabel(step);
    const slug = slugify(label);
    const base = slug ? `step_${slug}` : `actio_${jobId}_step_${idx + 1}`;
    const originalIf = typeof step.if === "string" ? step.if : undefined;
    const { attempts, delaySeconds, delayLabel } = cfg;
    const out: Step[] = [];

    let prevId: string | undefined;
    for (let n = 1; n <= attempts; n++) {
      const isLast = n === attempts;
      const guard = prevId ? `steps.${prevId}.outcome == 'failure'` : undefined;
      const condition = combineIf(originalIf, guard);

      if (delaySeconds != null && prevId) {
        const sleepStep: Step = deriveNode(ctx, step, {
          name: `Retry backoff (${delayLabel ?? `${delaySeconds}s`}) before attempt ${n}/${attempts}`,
          run: `sleep ${formatSeconds(delaySeconds)}`,
        });
        if (condition) sleepStep.if = condition;
        out.push(sleepStep);
      }

      const attempt = cloneNode(ctx, step);
      attempt.name = `${label} (attempt ${n}/${attempts})`;
      let id = `${base}_attempt_${n}`;
      let dedupe = 2;
      while (used.has(id)) id = `${base}_attempt_${n}_${dedupe++}`;
      used.add(id);
      attempt.id = id;

      if (condition) {
        attempt.if = condition;
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
  });
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
export const retry: Pass = { name: "retry", runsAfter: ["fragments"], apply: retryPass };

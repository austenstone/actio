import type { Range } from "./diagnostics.js";
import { type Origin, type ParseContext, type Path, rangeOfPath } from "./parser.js";

export type { Origin };

/**
 * Typed views over the mutable `ctx.data` model. We type only the fields passes
 * actually touch and keep an index signature so passthrough GitHub Actions keys
 * survive untyped. The IR wraps `ctx.data` — it does not replace it — so `emit`
 * keeps serializing the same objects byte-for-byte.
 */
export interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  shell?: string;
  "continue-on-error"?: boolean;
  inject?: string;
  retry?: unknown;
  fallback?: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: passthrough GHA keys stay dynamic
  [key: string]: any;
}

export interface Job {
  "runs-on"?: unknown;
  needs?: string | string[];
  if?: string;
  steps?: Step[];
  strategy?: Record<string, unknown>;
  permissions?: unknown;
  outputs?: Record<string, unknown>;
  env?: Record<string, unknown>;
  retry?: unknown;
  fallback?: unknown;
  dynamic_matrix?: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: passthrough GHA keys stay dynamic
  [key: string]: any;
}

export interface Workflow {
  name?: string;
  on?: unknown;
  jobs?: Record<string, Job>;
  fragments?: Record<string, Step | Step[]>;
  // biome-ignore lint/suspicious/noExplicitAny: passthrough GHA keys stay dynamic
  [key: string]: any;
}

/** Typed view of the workflow model passes transform. */
export function workflow(ctx: ParseContext): Workflow {
  return ctx.data as Workflow;
}

function jobsOf(ctx: ParseContext): Record<string, Job> {
  const jobs = workflow(ctx).jobs;
  return jobs && typeof jobs === "object" ? jobs : {};
}

// --- provenance -----------------------------------------------------------

/** The origin recorded for `node`, if any. */
export function originOf(ctx: ParseContext, node: object): Origin | undefined {
  return ctx.origins.get(node);
}

/** Attach an explicit origin to `node`. */
export function setOrigin(ctx: ParseContext, node: object, origin: Origin): void {
  ctx.origins.set(node, origin);
}

/**
 * Record `node`'s origin from a document `path`, resolving its source range.
 * Idempotent: an origin already on the node wins, so the earliest (pre-mutation)
 * mapping is preserved.
 */
export function recordOrigin(ctx: ParseContext, node: object, path: Path): Origin {
  const existing = ctx.origins.get(node);
  if (existing) return existing;
  const range: Range | undefined = rangeOfPath(ctx, path);
  const origin: Origin = { path, range };
  ctx.origins.set(node, origin);
  return origin;
}

/**
 * Deep-clone a node, carrying its origin onto the copy. `structuredClone` drops
 * the external WeakMap entry, so we copy it explicitly — this is what keeps
 * provenance pointing at the source through fan-out (e.g. retry attempts).
 */
export function cloneNode<T extends object>(ctx: ParseContext, node: T): T {
  const copy = structuredClone(node);
  const origin = ctx.origins.get(node);
  if (origin) ctx.origins.set(copy, origin);
  return copy;
}

/** Make a freshly built `node` map back to `from`'s source (synthetic nodes). */
export function deriveNode<T extends object>(ctx: ParseContext, from: object, node: T): T {
  const origin = ctx.origins.get(from);
  if (origin) ctx.origins.set(node, origin);
  return node;
}

// --- traversal ------------------------------------------------------------

export interface JobView {
  id: string;
  job: Job;
  path: Path;
  origin: Origin;
}

export interface StepView {
  jobId: string;
  job: Job;
  step: Step;
  index: number;
  path: Path;
  origin: Origin;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Visit each job, recording its origin on first sight. */
export function visitJobs(ctx: ParseContext, fn: (view: JobView) => void): void {
  for (const [id, job] of Object.entries(jobsOf(ctx))) {
    if (!isObject(job)) continue;
    const path: Path = ["jobs", id];
    fn({ id, job, path, origin: recordOrigin(ctx, job, path) });
  }
}

/** Visit each step of each job, recording per-step origins on first sight. */
export function visitSteps(ctx: ParseContext, fn: (view: StepView) => void): void {
  visitJobs(ctx, ({ id: jobId, job }) => {
    const steps = job.steps;
    if (!Array.isArray(steps)) return;
    steps.forEach((step, index) => {
      if (!isObject(step)) return;
      const path: Path = ["jobs", jobId, "steps", index];
      fn({ jobId, job, step, index, path, origin: recordOrigin(ctx, step, path) });
    });
  });
}

/**
 * Rebuild a job's `steps` in place: `fn` returns the replacement step(s) for
 * each input step, so a pass can fan one step out into many (retry attempts,
 * fallback notify steps) while keeping the surrounding steps untouched. Each
 * original step's origin is recorded before `fn` runs so replacements built
 * with `cloneNode`/`deriveNode` inherit it.
 */
export function transformSteps(
  ctx: ParseContext,
  jobId: string,
  job: Job,
  fn: (step: Step, index: number) => Step[],
): void {
  const steps = job.steps;
  if (!Array.isArray(steps)) return;
  const out: Step[] = [];
  steps.forEach((step, index) => {
    if (isObject(step)) {
      recordOrigin(ctx, step, ["jobs", jobId, "steps", index]);
    }
    out.push(...fn(step, index));
  });
  job.steps = out;
}

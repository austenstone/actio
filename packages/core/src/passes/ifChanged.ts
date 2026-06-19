import { deriveNode, type Job, type Step } from "../ir.js";
import { KEY_ORDER, type ParseContext, setKeyOrder } from "../parser.js";
import { combineIf, isObject, mergeNeeds, pushDiagnostic } from "./helpers.js";
import type { Pass } from "./registry.js";

// The single shared setup job and the paths-filter step inside it. One setup
// job serves every `if_changed` guard in the workflow; identical glob groups
// collapse onto one named filter so the diff is computed exactly once.
const SETUP_ID = "actio_changes";
const FILTER_STEP_ID = "actio_filter";

interface Usage {
  /** The node carrying `if_changed` (a job for job-level, a step for step-level). */
  node: Job | Step;
  /** The job that must gain `needs: [actio_changes]` (the parent job either way). */
  job: Job;
  jobId: string;
  globs: string[];
}

/** Order jobs the way dynamic_matrix does: honor KEY_ORDER, append stragglers. */
function jobOrder(jobs: Record<string, unknown>): string[] {
  const recorded = (jobs as Record<symbol, unknown>)[KEY_ORDER] as string[] | undefined;
  if (!recorded) return Object.keys(jobs);
  const seen = new Set(recorded);
  return [...recorded.filter((k) => k in jobs), ...Object.keys(jobs).filter((k) => !seen.has(k))];
}

/** Coerce a string-or-list `if_changed` value into a clean glob list. */
function normalizeGlobs(
  ctx: ParseContext,
  value: unknown,
  path: (string | number)[],
): string[] | undefined {
  const raw = Array.isArray(value) ? value : [value];
  const globs: string[] = [];
  for (const g of raw) {
    if (typeof g === "string" && g.trim() !== "") globs.push(g.trim());
    else pushDiagnostic(ctx, "warning", `if_changed entries must be non-empty glob strings`, path);
  }
  if (globs.length === 0) {
    pushDiagnostic(ctx, "warning", `if_changed has no usable glob patterns; ignoring`, path);
    return undefined;
  }
  return globs;
}

/**
 * if_changed pass: every step/job carrying an `if_changed` glob list is gated on
 * whether its files changed in the triggering diff. A single generated
 * `actio_changes` job runs `dorny/paths-filter` once (one named filter per unique
 * glob group), publishes a boolean output per group, and each guarded node folds
 * `needs.actio_changes.outputs.<flag> == 'true'` into its `if:` (AND) and gains
 * `needs: [actio_changes]`. dorny resolves the diff base per event automatically
 * (PR base for pull_request, the `before` SHA for push, with a first-push
 * fallback), so the same source works across triggers.
 */
export function ifChangedPass(ctx: ParseContext): void {
  const jobs = ctx.data.jobs;
  if (!isObject(jobs)) return;
  const order = jobOrder(jobs as Record<string, unknown>);

  // Phase 1: collect usages without mutating, so a setup-id collision can abort
  // cleanly before any guard or `needs` edit lands.
  const usages: Usage[] = [];
  for (const jobId of order) {
    const job = (jobs as Record<string, unknown>)[jobId];
    if (!isObject(job)) continue;
    const j = job as Job;
    if (j.if_changed !== undefined) {
      const globs = normalizeGlobs(ctx, j.if_changed, ["jobs", jobId, "if_changed"]);
      if (globs) usages.push({ node: j, job: j, jobId, globs });
      else delete j.if_changed;
    }
    const steps = j.steps;
    if (Array.isArray(steps)) {
      steps.forEach((step, i) => {
        if (!isObject(step)) return;
        const s = step as Step;
        if (s.if_changed === undefined) return;
        const globs = normalizeGlobs(ctx, s.if_changed, ["jobs", jobId, "steps", i, "if_changed"]);
        if (globs) usages.push({ node: s, job: j, jobId, globs });
        else delete s.if_changed;
      });
    }
  }
  const anchor = usages[0]?.job;
  if (anchor === undefined) return;

  if (order.includes(SETUP_ID)) {
    pushDiagnostic(
      ctx,
      "error",
      `if_changed must synthesize a setup job "${SETUP_ID}", but a job with that id already exists; rename that job`,
      ["jobs", SETUP_ID],
    );
    // Strip the macro keys so we never emit an invalid `if_changed` we couldn't wire up.
    for (const u of usages) delete (u.node as Record<string, unknown>).if_changed;
    return;
  }

  // Dedupe identical glob groups onto one named filter (first-seen order).
  const filterByKey = new Map<string, string>();
  const filters: { name: string; globs: string[] }[] = [];
  const filterFor = (globs: string[]): string => {
    const key = JSON.stringify(globs);
    const existing = filterByKey.get(key);
    if (existing) return existing;
    const name = `filter_${filters.length + 1}`;
    filterByKey.set(key, name);
    filters.push({ name, globs });
    return name;
  };

  // Phase 2: fold the guard into each node and wire its job's `needs`.
  for (const u of usages) {
    const flag = filterFor(u.globs);
    const guard = `needs.${SETUP_ID}.outputs.${flag} == 'true'`;
    u.node.if = combineIf(guard, u.node.if);
    u.job.needs = mergeNeeds(u.job.needs, [SETUP_ID]);
    delete (u.node as Record<string, unknown>).if_changed;
  }

  const setup = buildSetupJob(ctx, anchor, filters);

  // Emit the shared setup job first, then the original jobs in their prior order.
  const rebuilt: Record<string, unknown> = { [SETUP_ID]: setup };
  const rebuiltOrder: string[] = [SETUP_ID];
  for (const jobId of order) {
    rebuilt[jobId] = (jobs as Record<string, unknown>)[jobId];
    rebuiltOrder.push(jobId);
  }
  setKeyOrder(rebuilt, rebuiltOrder);
  ctx.data.jobs = rebuilt;
}

/** Build the shared `actio_changes` job that runs paths-filter once. */
function buildSetupJob(
  ctx: ParseContext,
  anchor: Job,
  filters: { name: string; globs: string[] }[],
): Job {
  // dorny consumes `filters` as an inline YAML document; we render it ourselves
  // so the named groups and their globs are explicit and stable in the output.
  const filtersYaml = filters
    .map(({ name, globs }) =>
      [`${name}:`, ...globs.map((g) => `  - '${g.replace(/'/g, "''")}'`)].join("\n"),
    )
    .join("\n");

  const outputs: Record<string, string> = {};
  for (const { name } of filters) {
    outputs[name] = `\${{ steps.${FILTER_STEP_ID}.outputs.${name} }}`;
  }

  return deriveNode(ctx, anchor, {
    "runs-on": "ubuntu-latest",
    outputs,
    steps: [
      // dorny needs the base commit available; checkout covers the push path
      // (PRs use the API). Keep it minimal and let dorny fetch what it needs.
      deriveNode(ctx, anchor, { uses: "actions/checkout@v4" }),
      deriveNode(ctx, anchor, {
        uses: "dorny/paths-filter@v3",
        id: FILTER_STEP_ID,
        with: { filters: filtersYaml },
      }),
    ],
  });
}

/** Gate steps/jobs on changed files via one shared paths-filter setup job. */
export const ifChanged: Pass = {
  name: "if_changed",
  runsAfter: ["fragments", "retry", "fallback", "dynamic_matrix", "lifecycle"],
  apply: ifChangedPass,
};

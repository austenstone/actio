import type { Job } from "../ir.js";
import type { ParseContext } from "../parser.js";
import { isObject, pushDiagnostic } from "./helpers.js";
import type { Pass } from "./registry.js";

/** Job key of the injected annotation job. */
export const ANNOTATE_JOB_ID = "actio-annotate";

/** Repo-relative path GitHub resolves `uses:` from (always the repo root). */
export const ANNOTATE_ACTION = "./.github/actions/actio-annotate";

/**
 * Append a synthetic job that runs after every real job and, on failure, maps
 * the failed step back to its `.actio.yml` source via the sidecar `.yml.map` and
 * emits workflow annotations. The job carries no origin, so it stays unmapped in
 * the source map (it isn't user source). Skipped when there are no jobs or a job
 * named `actio-annotate` already exists.
 */
export function annotatePass(ctx: ParseContext): void {
  const jobs = ctx.data.jobs;
  if (!isObject(jobs)) return;

  const keys = Object.keys(jobs);
  if (keys.length === 0) return;

  if (Object.hasOwn(jobs, ANNOTATE_JOB_ID)) {
    pushDiagnostic(
      ctx,
      "warning",
      `Skipping annotation injection: a job named "${ANNOTATE_JOB_ID}" already exists`,
      ["jobs", ANNOTATE_JOB_ID],
    );
    return;
  }

  const job: Job = {
    name: "Actio annotate",
    "runs-on": "ubuntu-latest",
    needs: keys,
    if: "failure()",
    permissions: { contents: "read", actions: "read" },
    steps: [
      { uses: "actions/checkout@v4" },
      { uses: ANNOTATE_ACTION, with: { token: "${{ github.token }}" } },
    ],
  };

  (jobs as Record<string, Job>)[ANNOTATE_JOB_ID] = job;
}

/**
 * annotate pass: inject the `actio-annotate` reporting job. Runs after every
 * other built-in so it captures the final job set (including dynamic-matrix
 * setup jobs). Opt-in — only registered by `transpile` when annotation is on.
 */
export const annotate: Pass = {
  name: "annotate",
  runsAfter: ["fragments", "retry", "fallback", "dynamic_matrix", "lifecycle"],
  apply: annotatePass,
};

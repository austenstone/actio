import { type Job, type Step, deriveNode } from "../ir.js";
import type { ParseContext } from "../parser.js";
import {
  asArray,
  combineIf,
  isObject,
  looksLikePath,
  mergeNeeds,
  pushDiagnostic,
} from "./helpers.js";
import type { Pass } from "./registry.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamic config object
type DM = Record<string, any>;

function opt<T>(dm: DM, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (dm[k] !== undefined) return dm[k] as T;
  }
  return undefined;
}

function resolveRunsOn(dm: DM, job: Job): unknown {
  const fromDm = opt<unknown>(dm, "runs-on", "runs_on");
  if (fromDm !== undefined) return fromDm;
  if (typeof job["runs-on"] === "string") return job["runs-on"];
  return "ubuntu-latest";
}

function buildEvalRun(script: string, compact: boolean): string {
  const pipe = compact ? " | jq -c ." : "";
  return [
    "{",
    "  echo 'matrix<<ACTIO_EOF'",
    `  ${script}${pipe}`,
    "  echo ACTIO_EOF",
    '} >> "$GITHUB_OUTPUT"',
  ].join("\n");
}

function buildSetupJob(ctx: ParseContext, jobId: string, job: Job): Job | undefined {
  const dm = job.dynamic_matrix as DM;
  const script = opt<string>(dm, "script", "run");
  if (typeof script !== "string" || script.trim() === "") {
    pushDiagnostic(ctx, "error", `Job "${jobId}": dynamic_matrix requires a "script" string`, [
      "jobs",
      jobId,
      "dynamic_matrix",
    ]);
    return undefined;
  }

  const checkout = typeof dm.checkout === "boolean" ? dm.checkout : looksLikePath(script);
  const compact = dm.compact !== false;
  const shell = opt<string>(dm, "shell");

  const steps: Step[] = [];
  if (checkout) steps.push(deriveNode(ctx, job, { uses: "actions/checkout@v4" }));
  for (const s of asArray<Step>(opt<Step | Step[]>(dm, "before", "setup_steps"))) {
    steps.push(isObject(s) ? deriveNode(ctx, job, s) : s);
  }
  const evalStep: Step = deriveNode(ctx, job, {
    name: "Evaluate dynamic matrix",
    id: "actio_eval",
    run: buildEvalRun(script, compact),
  });
  if (shell) evalStep.shell = shell;
  steps.push(evalStep);

  const setup: Job = deriveNode(ctx, job, {
    "runs-on": resolveRunsOn(dm, job),
    outputs: { matrix: "${{ steps.actio_eval.outputs.matrix }}" },
    steps,
  });
  // Carry permissions/env through to the setup job when the script may need them.
  if (job.permissions !== undefined) setup.permissions = job.permissions;
  return setup;
}

function transformTargetJob(ctx: ParseContext, jobId: string, job: Job, setupId: string): void {
  const dm = job.dynamic_matrix as DM;
  const alias = opt<string>(dm, "alias", "as");
  const matrixExpr = `\${{ fromJSON(needs.${setupId}.outputs.matrix) }}`;

  job.needs = mergeNeeds(job.needs, [setupId]);

  const strategy: Record<string, unknown> = isObject(job.strategy) ? job.strategy : {};
  if (strategy.matrix !== undefined) {
    pushDiagnostic(
      ctx,
      "warning",
      `Job "${jobId}": existing strategy.matrix is overwritten by dynamic_matrix`,
      ["jobs", jobId, "strategy", "matrix"],
    );
  }
  strategy.matrix = alias ? { [alias]: matrixExpr } : matrixExpr;

  const failFast = opt<boolean>(dm, "fail-fast", "fail_fast");
  if (failFast !== undefined) {
    strategy["fail-fast"] = failFast;
  } else if (strategy["fail-fast"] === undefined) {
    strategy["fail-fast"] = false;
  }
  job.strategy = strategy;

  const guard = `needs.${setupId}.outputs.matrix != '[]' && needs.${setupId}.outputs.matrix != ''`;
  job.if = combineIf(guard, job.if);

  delete job.dynamic_matrix;
}

/**
 * dynamic_matrix pass: each job with a `dynamic_matrix` block is split into a
 * generated `actio_setup_<jobId>` job (runs the script, publishes compact JSON
 * as an output) and the original job (consumes it via `fromJSON`, with a
 * fail-fast:false default and an empty-matrix guard). The setup job is emitted
 * immediately before its target for readable output.
 */
export function dynamicMatrixPass(ctx: ParseContext): void {
  const jobs = ctx.data.jobs;
  if (!isObject(jobs)) return;

  const rebuilt: Record<string, unknown> = {};
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObject(job) || (job as Job).dynamic_matrix == null) {
      rebuilt[jobId] = job;
      continue;
    }
    const setupId = `actio_setup_${jobId}`;
    const setup = buildSetupJob(ctx, jobId, job as Job);
    if (!setup) {
      // Leave the job intact (minus the macro key) so other passes/validation proceed.
      delete (job as Job).dynamic_matrix;
      rebuilt[jobId] = job;
      continue;
    }
    transformTargetJob(ctx, jobId, job as Job, setupId);
    rebuilt[setupId] = setup;
    rebuilt[jobId] = job;
  }
  ctx.data.jobs = rebuilt;
}

/** Split jobs and move the (already finalized) steps. Runs last. */
export const dynamicMatrix: Pass = {
  name: "dynamic_matrix",
  runsAfter: ["fragments", "retry", "fallback"],
  apply: dynamicMatrixPass,
};

import { deriveNode, type Job, type Step } from "../ir.js";
import { KEY_ORDER, type ParseContext, setKeyOrder } from "../parser.js";
import {
  asArray,
  combineIf,
  isObject,
  looksLikePath,
  mergeNeeds,
  pushDiagnostic,
} from "./helpers.js";
import type { Pass } from "./registry.js";

type DM = Record<string, unknown>;

const DM_KEYS = new Set([
  "script",
  "run",
  "shell",
  "checkout",
  "compact",
  "alias",
  "as",
  "mode",
  "id",
  "runs-on",
  "runs_on",
  "before",
  "setup_steps",
  "fail-fast",
  "fail_fast",
]);

function opt<T>(dm: DM, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (dm[k] !== undefined) return dm[k] as T;
  }
  return undefined;
}

/**
 * Whether a `runs-on` value is a `${{ matrix.* }}` expression. Such a value is
 * meaningful on the consuming matrix job, but the generated setup job has no
 * matrix context, so inheriting it would resolve empty and break the runner.
 */
function runsOnUsesMatrix(runsOn: unknown): boolean {
  return typeof runsOn === "string" && /\$\{\{[^}]*\bmatrix\.[^}]*\}\}/.test(runsOn);
}

function resolveRunsOn(dm: DM, job: Job): unknown {
  const fromDm = opt<unknown>(dm, "runs-on", "runs_on");
  if (fromDm !== undefined) return fromDm;
  // Heterogeneous/include fan-out commonly sets `runs-on: ${{ matrix.runs-on }}`
  // on the consuming job. Don't hand that to the (matrix-less) setup job.
  if (typeof job["runs-on"] === "string" && !runsOnUsesMatrix(job["runs-on"])) {
    return job["runs-on"];
  }
  return "ubuntu-latest";
}

type MatrixMode = "include" | "alias";

/**
 * Resolve include vs alias mode. An explicit `mode: include|alias` wins;
 * otherwise the mode is inferred from the presence of `alias` (back-compat).
 */
function resolveMatrixMode(
  ctx: ParseContext,
  jobId: string,
  dm: DM,
  alias: string | undefined,
): MatrixMode {
  const mode = opt<string>(dm, "mode");
  if (mode === undefined) return alias !== undefined ? "alias" : "include";
  if (mode !== "include" && mode !== "alias") {
    pushDiagnostic(
      ctx,
      "error",
      `Job "${jobId}": dynamic_matrix mode "${mode}" is invalid; use "include" or "alias"`,
      ["jobs", jobId, "dynamic_matrix", "mode"],
    );
    return alias !== undefined ? "alias" : "include";
  }
  if (mode === "alias" && alias === undefined) {
    pushDiagnostic(
      ctx,
      "error",
      `Job "${jobId}": dynamic_matrix mode "alias" requires an "alias" key`,
      ["jobs", jobId, "dynamic_matrix", "mode"],
    );
    return "include";
  }
  if (mode === "include" && alias !== undefined) {
    pushDiagnostic(
      ctx,
      "warning",
      `Job "${jobId}": dynamic_matrix mode "include" ignores the "alias" key; the script's array (or {include:[...]}) passes straight into strategy.matrix`,
      ["jobs", jobId, "dynamic_matrix", "alias"],
    );
  }
  return mode;
}

type ShellFamily = "posix" | "pwsh" | "python" | "unsupported";

/** Map a GitHub Actions `shell:` value to the plumbing we know how to emit. */
function shellFamily(shell: string | undefined): ShellFamily {
  if (!shell) return "posix";
  switch (shell.trim().toLowerCase()) {
    case "bash":
    case "sh":
      return "posix";
    case "pwsh":
    case "powershell":
      return "pwsh";
    case "python":
      return "python";
    default:
      return "unsupported";
  }
}

/**
 * bash/sh: a brace group streams the script's combined stdout into the heredoc
 * body, so a multi-line script emits the matrix JSON (not just its last line).
 * `compact` pipes that stdout through `jq -c .` to normalize to one line.
 */
function posixEvalRun(lines: string[], compact: boolean): string {
  let evalBlock: string[];
  if (!compact) {
    evalBlock = lines.map((l) => `  ${l}`);
  } else if (lines.length === 1) {
    evalBlock = [`  ${lines[0]} | jq -c .`];
  } else {
    evalBlock = ["  {", ...lines.map((l) => `    ${l}`), "  } | jq -c ."];
  }
  return [
    "{",
    "  echo 'matrix<<ACTIO_EOF'",
    ...evalBlock,
    "  echo ACTIO_EOF",
    '} >> "$GITHUB_OUTPUT"',
  ].join("\n");
}

/**
 * pwsh/powershell: capture the script's pipeline output, then append the
 * multi-line GHA output via .NET so it stays BOM-free on both PowerShell Core
 * and Windows PowerShell (`>>` / `Out-File` would add a BOM or UTF-16 on
 * Desktop and corrupt `$GITHUB_OUTPUT`).
 */
function pwshEvalRun(lines: string[]): string {
  return [
    "$actioOut = & {",
    ...lines.map((l) => `  ${l}`),
    "}",
    "$actioBody = ($actioOut | Out-String).TrimEnd()",
    '[System.IO.File]::AppendAllText($env:GITHUB_OUTPUT, "matrix<<ACTIO_EOF`n$actioBody`nACTIO_EOF`n", (New-Object System.Text.UTF8Encoding $false))',
  ].join("\n");
}

/** python: capture stdout, then append the multi-line output BOM-free. */
function pythonEvalRun(lines: string[]): string {
  return [
    "import os, io, contextlib",
    "_actio_buf = io.StringIO()",
    "with contextlib.redirect_stdout(_actio_buf):",
    ...lines.map((l) => `    ${l}`),
    'with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as _actio_fh:',
    '    _actio_fh.write("matrix<<ACTIO_EOF\\n" + _actio_buf.getvalue().rstrip("\\n") + "\\nACTIO_EOF\\n")',
  ].join("\n");
}

/**
 * Build the `run:` for the setup job's eval step. The user's `script` runs under
 * the chosen `shell` (like Actions), and Actio supplies shell-matching plumbing
 * to publish its stdout as the `matrix` output.
 */
function buildEvalRun(script: string, compact: boolean, family: ShellFamily): string {
  const lines = script.replace(/\n+$/, "").split("\n");
  switch (family) {
    case "pwsh":
      return pwshEvalRun(lines);
    case "python":
      return pythonEvalRun(lines);
    default:
      return posixEvalRun(lines, compact);
  }
}

function buildSetupJob(ctx: ParseContext, jobId: string, job: Job): Job | undefined {
  const dm = job.dynamic_matrix as DM;
  for (const key of Object.keys(dm)) {
    if (!DM_KEYS.has(key)) {
      pushDiagnostic(ctx, "warning", `Job "${jobId}": dynamic_matrix has unknown key "${key}"`, [
        "jobs",
        jobId,
        "dynamic_matrix",
        key,
      ]);
    }
  }
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
  const shell = opt<string>(dm, "shell");
  const family = shellFamily(shell);
  if (family === "unsupported") {
    pushDiagnostic(
      ctx,
      "error",
      `Job "${jobId}": dynamic_matrix shell "${shell}" is not supported; use bash, sh, pwsh, powershell, or python`,
      ["jobs", jobId, "dynamic_matrix", "shell"],
    );
    return undefined;
  }

  // `compact` (jq) is a POSIX-only convenience. Other shells emit the script's
  // raw stdout as a multi-line output, which `fromJSON` parses fine.
  const compact = family === "posix" && dm.compact !== false;
  if (dm.compact === true && family !== "posix") {
    pushDiagnostic(
      ctx,
      "warning",
      `Job "${jobId}": dynamic_matrix "compact" only applies to bash/sh; "${shell}" emits the script's raw output instead`,
      ["jobs", jobId, "dynamic_matrix", "compact"],
    );
  }

  const steps: Step[] = [];
  if (checkout) steps.push(deriveNode(ctx, job, { uses: "actions/checkout@v4" }));
  for (const s of asArray<Step>(opt<Step | Step[]>(dm, "before", "setup_steps"))) {
    steps.push(isObject(s) ? deriveNode(ctx, job, s) : s);
  }
  const evalStep: Step = deriveNode(ctx, job, {
    name: "Evaluate dynamic matrix",
    id: "actio_eval",
    run: buildEvalRun(script, compact, family),
  });
  if (shell) evalStep.shell = shell;
  steps.push(evalStep);

  const setup: Job = deriveNode(ctx, job, {
    "runs-on": resolveRunsOn(dm, job),
    outputs: { matrix: "${{ steps.actio_eval.outputs.matrix }}" },
    steps,
  });
  // Carry context the matrix script may read: permissions, the target's
  // upstream `needs`, and job-level `env`.
  if (job.permissions !== undefined) setup.permissions = job.permissions;
  if (job.needs !== undefined) setup.needs = job.needs;
  if (job.env !== undefined) setup.env = job.env;
  return setup;
}

function transformTargetJob(ctx: ParseContext, jobId: string, job: Job, setupId: string): void {
  const dm = job.dynamic_matrix as DM;
  const alias = opt<string>(dm, "alias", "as");
  const matrixExpr = `\${{ fromJSON(needs.${setupId}.outputs.matrix) }}`;
  const mode = resolveMatrixMode(ctx, jobId, dm, alias);
  const useAlias = mode === "alias" && alias !== undefined;
  const matrixValue: unknown = useAlias ? { [alias as string]: matrixExpr } : matrixExpr;
  const inlineStrategy = ctx.internal.jobDefaults?.inlineStrategyJobs?.[jobId] === true;
  const inlineSetFailFast = ctx.internal.jobDefaults?.inlineStrategyFailFastJobs?.[jobId] === true;

  job.needs = mergeNeeds(job.needs, [setupId]);

  const strategy: Record<string, unknown> = isObject(job.strategy) ? job.strategy : {};
  if (strategy.matrix !== undefined) {
    if (inlineStrategy) {
      pushDiagnostic(
        ctx,
        "warning",
        `Job "${jobId}": inline strategy.matrix is preserved; dynamic_matrix skips only the inherited/default strategy.matrix override while setup/needs/guard transforms still apply`,
        ["jobs", jobId, "strategy", "matrix"],
      );
    } else {
      pushDiagnostic(
        ctx,
        "warning",
        `Job "${jobId}": existing strategy.matrix is overwritten by dynamic_matrix`,
        ["jobs", jobId, "strategy", "matrix"],
      );
      strategy.matrix = matrixValue;
    }
  } else {
    strategy.matrix = matrixValue;
  }

  const failFast = opt<boolean>(dm, "fail-fast", "fail_fast");
  if (inlineSetFailFast) {
    if (failFast !== undefined) {
      pushDiagnostic(
        ctx,
        "warning",
        `Job "${jobId}": inline strategy.fail-fast is preserved; dynamic_matrix fail-fast is ignored`,
        ["jobs", jobId, "strategy", "fail-fast"],
      );
    }
  } else if (failFast !== undefined) {
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

  const recorded = (jobs as Record<symbol, unknown>)[KEY_ORDER] as string[] | undefined;
  const seen = new Set(recorded ?? []);
  const order = recorded
    ? [...recorded.filter((k) => k in jobs), ...Object.keys(jobs).filter((k) => !seen.has(k))]
    : Object.keys(jobs);

  const allJobIds = new Set(order);
  // Track setup ids we have already generated so two different dynamic_matrix
  // jobs that resolve to the same setupId can't overwrite each other in the
  // rebuild (the same silent-drop/dangling-needs failure mode as an original-id
  // collision, just between two generated jobs).
  const generatedSetupIds = new Set<string>();
  const rebuilt: Record<string, unknown> = {};
  const rebuiltOrder: string[] = [];
  for (const jobId of order) {
    const job = (jobs as Record<string, unknown>)[jobId];
    if (!isObject(job) || (job as Job).dynamic_matrix == null) {
      rebuilt[jobId] = job;
      rebuiltOrder.push(jobId);
      continue;
    }
    if (!isObject((job as Job).dynamic_matrix)) {
      const dmVal = (job as Job).dynamic_matrix;
      pushDiagnostic(
        ctx,
        "error",
        `Job "${jobId}": dynamic_matrix must be a mapping with a "script" (got ${
          dmVal === null ? "null" : Array.isArray(dmVal) ? "array" : typeof dmVal
        })`,
        ["jobs", jobId, "dynamic_matrix"],
      );
      delete (job as Job).dynamic_matrix;
      rebuilt[jobId] = job;
      rebuiltOrder.push(jobId);
      continue;
    }
    const setupId = opt<string>(job.dynamic_matrix as DM, "id") ?? `actio_setup_${jobId}`;
    // The generated setup job is stored as `rebuilt[setupId]`; if that id equals
    // the consuming job's own id, another existing job id, or a setup id already
    // generated for an earlier dynamic_matrix job, the plain-object rebuild would
    // overwrite one with the other and silently drop a job, leaving
    // `needs.<setupId>` dangling. Refuse rather than corrupt.
    if (allJobIds.has(setupId) || generatedSetupIds.has(setupId)) {
      const reason =
        setupId === jobId
          ? `equals the consuming job's own id`
          : generatedSetupIds.has(setupId)
            ? `collides with another generated setup job "${setupId}"`
            : `collides with an existing job "${setupId}"`;
      pushDiagnostic(
        ctx,
        "error",
        `Job "${jobId}": dynamic_matrix.id "${setupId}" ${reason}; choose a unique dynamic_matrix.id for the generated setup job`,
        ["jobs", jobId, "dynamic_matrix", "id"],
      );
      // Leave the input job untouched so we never emit a workflow that
      // references a setup job we couldn't safely create.
      rebuilt[jobId] = job;
      rebuiltOrder.push(jobId);
      continue;
    }
    const setup = buildSetupJob(ctx, jobId, job as Job);
    if (!setup) {
      // Leave the job intact (minus the macro key) so other passes/validation proceed.
      delete (job as Job).dynamic_matrix;
      rebuilt[jobId] = job;
      rebuiltOrder.push(jobId);
      continue;
    }
    transformTargetJob(ctx, jobId, job as Job, setupId);
    generatedSetupIds.add(setupId);
    rebuilt[setupId] = setup;
    rebuiltOrder.push(setupId);
    rebuilt[jobId] = job;
    rebuiltOrder.push(jobId);
  }
  setKeyOrder(rebuilt, rebuiltOrder);
  ctx.data.jobs = rebuilt;
}

/** Split jobs and move the (already finalized) steps. Runs last. */
export const dynamicMatrix: Pass = {
  name: "dynamic_matrix",
  runsAfter: ["fragments", "retry", "fallback"],
  apply: dynamicMatrixPass,
};

import { type Job, type Step, transformSteps, visitJobs, workflow } from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import { isObject, pushDiagnostic, sourcePathFor } from "./helpers.js";
import type { Pass } from "./registry.js";

type Normalized = { kind: "off" } | { kind: "any" } | { kind: "codes"; codes: number[] };

const SUPPORTED_LIST_SHELLS = "bash, sh, and pwsh";

function formatValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Parse `soft_fail`. `true` tolerates any non-zero exit; a list tolerates only
 * the listed codes. Anything malformed emits an `error` so the user fixes a
 * broken config rather than silently shipping a step with no protection.
 */
function normalizeSoftFail(ctx: ParseContext, raw: unknown, path?: Path): Normalized | null {
  if (raw === true) return { kind: "any" };
  if (raw === false) return { kind: "off" };
  if (Array.isArray(raw)) {
    const codes: number[] = [];
    const seen = new Set<number>();
    let invalid = false;
    for (const entry of raw) {
      if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 255) {
        pushDiagnostic(
          ctx,
          "error",
          `soft_fail exit codes must be integers 0-255 (got ${formatValue(entry)})`,
          path,
          { hint: "use e.g. `soft_fail: [0, 42]`" },
        );
        invalid = true;
        continue;
      }
      if (!seen.has(entry)) {
        seen.add(entry);
        codes.push(entry);
      }
    }
    if (invalid) return null;
    if (codes.length === 0) {
      pushDiagnostic(ctx, "error", "soft_fail list must contain at least one exit code", path, {
        hint: "use `soft_fail: true` to tolerate any non-zero exit, or list codes like `[0, 42]`",
      });
      return null;
    }
    return { kind: "codes", codes };
  }
  pushDiagnostic(
    ctx,
    "error",
    `soft_fail must be true or a list of integer exit codes (got ${formatValue(raw)})`,
    path,
    { hint: "`soft_fail: true` or `soft_fail: [0, 42]`" },
  );
  return null;
}

function shellOf(node: Record<string, unknown>): string | undefined {
  const defaults = node.defaults;
  if (!isObject(defaults)) return undefined;
  const run = defaults.run;
  if (!isObject(run)) return undefined;
  return typeof run.shell === "string" ? run.shell : undefined;
}

/** Effective shell: step beats job defaults beats workflow defaults; else unset. */
function resolveShell(ctx: ParseContext, job: Job, step: Step): string | undefined {
  if (typeof step.shell === "string") return step.shell;
  return shellOf(job) ?? shellOf(workflow(ctx));
}

/** POSIX single-quote: wrap in '…', rewriting each ' as '\'' so any byte is safe. */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** PowerShell single-quote: wrap in '…', doubling each ' so any byte is safe. */
function pwshQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * bash/sh wrapper. The user script is written verbatim to a temp file and run in
 * a FRESH child shell with the same strict flags GitHub uses, so the child keeps
 * its own `-e`/`pipefail` fail-fast and aggregate exit, and an explicit `exit N`
 * only ends the child. The outer shell captures that exit on the left of `||`
 * (so its own `-e` never aborts first) and remaps allowed codes to success.
 */
function posixWrapper(script: string, codes: number[], inner: "bash" | "sh"): string {
  const invoke =
    inner === "bash"
      ? 'bash --noprofile --norc -eo pipefail "$__actio_sf_file"'
      : 'sh -e "$__actio_sf_file"';
  return [
    '__actio_sf_file="$(mktemp)"',
    `printf '%s\\n' ${posixQuote(script)} > "$__actio_sf_file"`,
    "__actio_sf_code=0",
    `${invoke} || __actio_sf_code=$?`,
    'rm -f "$__actio_sf_file"',
    `case "$__actio_sf_code" in ${codes.join("|")}) exit 0 ;; *) exit "$__actio_sf_code" ;; esac`,
  ].join("\n");
}

/**
 * pwsh wrapper. The outer shell neutralizes native-error throwing first (GitHub
 * prepends `Stop` + native-throw, which would abort on the child's non-zero exit
 * before the remap runs), then runs the user script as a child `pwsh -File`. The
 * child re-arms GitHub's exact standalone-step semantics (`Stop` + native-throw +
 * guarded `exit $LASTEXITCODE`) so the user's own cmdlet/native fail-fast and
 * final exit code are identical to a normal pwsh step; the outer then remaps that
 * child exit. The script is embedded as a single-quoted literal so any byte is safe.
 *
 * The remap uses `[System.Environment]::Exit`, not `exit`: GitHub invokes pwsh as
 * `pwsh -command ". '{0}'"`, and a dot-sourced *file* that calls `exit N` collapses
 * the process code to 1 for any non-zero N. `[System.Environment]::Exit` terminates
 * the process with the exact code, surviving that dot-source quirk so a disallowed
 * code re-exits faithfully (and the allowed branch exits a clean 0).
 */
function pwshWrapper(script: string, codes: number[]): string {
  const childScript = [
    "$ErrorActionPreference = 'Stop'",
    "if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $true }",
    script,
    "if (Test-Path variable:LASTEXITCODE) { exit $LASTEXITCODE }",
  ].join("\n");
  return [
    "$ErrorActionPreference = 'Continue'",
    "if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }",
    "$__actio_sf_ps1 = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName() + '.ps1')",
    `Set-Content -LiteralPath $__actio_sf_ps1 -Value ${pwshQuote(childScript)}`,
    "& pwsh -NoProfile -File $__actio_sf_ps1",
    "$__actio_sf_code = $LASTEXITCODE",
    "Remove-Item -LiteralPath $__actio_sf_ps1 -ErrorAction SilentlyContinue",
    "if ($null -eq $__actio_sf_code) { $__actio_sf_code = 0 }",
    `if (@(${codes.join(", ")}) -contains $__actio_sf_code) { [System.Environment]::Exit(0) } else { [System.Environment]::Exit($__actio_sf_code) }`,
  ].join("\n");
}

function expandStep(ctx: ParseContext, jobId: string, job: Job, step: Step, idx: number): Step[] {
  if (!isObject(step) || step.soft_fail === undefined) return [step];
  const path = sourcePathFor(ctx, step, ["jobs", jobId, "steps", idx], ["soft_fail"]);
  const norm = normalizeSoftFail(ctx, step.soft_fail, path);
  delete step.soft_fail;
  if (norm === null || norm.kind === "off") return [step];

  // `true` tolerates any non-zero exit; continue-on-error is the cleanest map and
  // works for run and uses steps on every shell (the step still shows as failed).
  if (norm.kind === "any") {
    step["continue-on-error"] = true;
    return [step];
  }

  // A code list needs a run step whose exit we can intercept; a uses step's action
  // exit cannot be remapped.
  if (typeof step.run !== "string") {
    pushDiagnostic(
      ctx,
      "error",
      'soft_fail with an exit-code list only applies to "run" steps; use `soft_fail: true` to tolerate any failure on this step',
      path,
      { hint: "`soft_fail: true` sets continue-on-error" },
    );
    return [step];
  }

  const shell = resolveShell(ctx, job, step);
  let inner: "bash" | "sh" | "pwsh";
  let pinBash = false;
  if (shell === undefined) {
    inner = "bash";
    pinBash = true;
  } else if (shell === "bash" || shell === "sh" || shell === "pwsh") {
    inner = shell;
  } else {
    pushDiagnostic(
      ctx,
      "error",
      `soft_fail with an exit-code list supports only ${SUPPORTED_LIST_SHELLS} shells (got "${shell}")`,
      path,
      { hint: "switch the step to a supported shell, or use `soft_fail: true`" },
    );
    return [step];
  }

  step.run =
    inner === "pwsh"
      ? pwshWrapper(step.run, norm.codes)
      : posixWrapper(step.run, norm.codes, inner);
  if (pinBash) step.shell = "bash";
  return [step];
}

/**
 * soft_fail pass: rewrites a `run:` step so listed exit codes map to success,
 * compiled fully at build time into a shell wrapper. Runs after `retry` and
 * `fallback` so it wraps each already-flattened attempt/recover step in place.
 */
export function softFailPass(ctx: ParseContext): void {
  visitJobs(ctx, ({ id: jobId, job }) => {
    if (!Array.isArray(job.steps)) return;
    transformSteps(ctx, jobId, job, (step, idx) => expandStep(ctx, jobId, job, step, idx));
  });
}

export const softFail: Pass = {
  name: "soft-fail",
  runsAfter: ["retry", "fallback"],
  apply: softFailPass,
};

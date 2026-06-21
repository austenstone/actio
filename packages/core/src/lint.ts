import { spawnSync } from "node:child_process";
import type { Diagnostic, Severity } from "./diagnostics.js";

/** Output-lint severity. `off` skips actionlint entirely. */
export type LintMode = "off" | "warn" | "error";

export const LINT_MODES = ["off", "warn", "error"] as const;

/** A single actionlint finding, parsed from its `{{json .}}` output. */
export interface ActionlintFinding {
  message: string;
  /** 1-based line on the generated workflow. */
  line: number;
  /** 1-based column on the generated workflow. */
  column: number;
  /** 1-based end column, when actionlint reports one. */
  end_column?: number;
  /** actionlint rule id (e.g. `job-needs`). */
  kind?: string;
}

/** Outcome of attempting to run actionlint. */
export interface ActionlintRun {
  /** False when the binary was not found on PATH (graceful skip). */
  available: boolean;
  findings: ActionlintFinding[];
  /** Set when actionlint ran but its output could not be used. */
  error?: string;
}

/** Runs actionlint over workflow text and returns its findings. Injectable for tests. */
export type ActionlintRunner = (yamlText: string) => ActionlintRun;

/** Minimal `spawnSync` surface so tests can drive the runner without a real binary. */
export type SpawnSync = (
  command: string,
  args: string[],
  options: { input: string; encoding: "utf8" },
) => { stdout?: string | null; error?: Error };

/**
 * Default runner: pipe the workflow to a local `actionlint` over stdin and parse
 * its JSON findings. A missing binary (ENOENT) resolves to `available: false`
 * rather than throwing, so an absent linter never fails a build.
 */
export function defaultActionlintRunner(
  yamlText: string,
  spawn: SpawnSync = spawnSync as unknown as SpawnSync,
): ActionlintRun {
  const res = spawn("actionlint", ["-no-color", "-format", "{{json .}}", "-"], {
    input: yamlText,
    encoding: "utf8",
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { available: false, findings: [] }
      : { available: true, findings: [], error: res.error.message };
  }
  const stdout = (res.stdout ?? "").trim();
  if (!stdout) return { available: true, findings: [] };
  try {
    return { available: true, findings: JSON.parse(stdout) as ActionlintFinding[] };
  } catch {
    return { available: true, findings: [], error: "actionlint produced unparseable output" };
  }
}

/**
 * Lint generated workflow YAML with actionlint and return diagnostics at the
 * mode's severity. Findings carry generated-line ranges that `transpile` remaps
 * back to the originating `.actio.yml` position via the source map. When the
 * binary is absent the linter is skipped with a single informational note.
 */
export function lintWorkflowYaml(
  yamlText: string,
  fileName: string,
  mode: LintMode,
  runner: ActionlintRunner = defaultActionlintRunner,
): Diagnostic[] {
  if (mode === "off") return [];

  const run = runner(yamlText);
  if (!run.available) {
    return [
      {
        severity: "info",
        source: "actio",
        file: fileName,
        message: "actionlint not found on PATH; skipping output lint",
        hint: "Install actionlint (https://github.com/rhysd/actionlint) to enable output linting.",
        code: "actionlint-unavailable",
      },
    ];
  }
  if (run.error) {
    return [
      {
        severity: "warning",
        source: "actio",
        file: fileName,
        message: `Could not lint generated workflow: ${run.error}`,
        code: "actionlint-failed",
      },
    ];
  }

  const severity: Severity = mode === "error" ? "error" : "warning";
  return run.findings.map((f) => ({
    severity,
    source: "actionlint",
    file: fileName,
    message: f.message,
    code: f.kind ? `actionlint-${f.kind}` : "actionlint",
    range: {
      start: { line: f.line, col: f.column },
      end: { line: f.line, col: f.end_column ?? f.column },
    },
  }));
}

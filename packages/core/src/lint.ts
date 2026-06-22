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
  runner: ActionlintRunner,
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

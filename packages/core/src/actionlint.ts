import { spawnSync } from "node:child_process";
import type { ActionlintFinding, ActionlintRun } from "./lint.js";

// Node-only home for the spawn-based actionlint runner. Kept out of lint.ts so
// the pure lint logic (and `transpile`) stays free of `node:child_process`,
// letting the browser sub-path entry bundle without node builtins (#155).

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

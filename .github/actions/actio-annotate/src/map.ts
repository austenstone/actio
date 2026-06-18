/**
 * Pure mapping helpers for the actio-annotate action. Kept dependency-free (no
 * `@actions/*`) so they can be unit-tested directly. These reimplement the tiny
 * slice of the source-map format the action needs at runtime — deliberately not
 * importing `actio-core`, to keep the bundled `dist` lean.
 */

export interface SourceMapping {
  generated: { line: number };
  source: number;
  original: { line: number; col: number };
  path?: string;
}

export interface SourceMap {
  version: number;
  generator: string;
  file: string;
  sources: string[];
  mappings: SourceMapping[];
}

/** A failed location resolved back to its original `.actio.yml` source. */
export interface ResolvedLocation {
  file: string;
  line: number;
  col: number;
}

/**
 * The default name GitHub shows for a step that has no explicit `name:`.
 * `uses` steps surface as their action ref; `run` steps as `Run <first line>`.
 */
export function defaultStepName(step: Record<string, unknown>): string {
  if (typeof step.name === "string" && step.name.length > 0) return step.name;
  if (typeof step.uses === "string") return step.uses;
  if (step.run != null) return `Run ${String(step.run).split("\n")[0]}`;
  return "";
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Match an API job's display name to the generated job key. Matrix legs surface
 * as `Display Name (leg)`, so an exact match OR a `Name (` prefix both count.
 */
export function matchJobKey(
  apiJobName: string,
  jobs: Record<string, { name?: string }>,
): string | undefined {
  const target = norm(apiJobName);
  for (const [key, def] of Object.entries(jobs)) {
    const display = norm(def.name ?? key);
    if (target === display || target.startsWith(`${display} (`)) return key;
  }
  return undefined;
}

/**
 * Match a failed API step name to its index in the YAML job's `steps`. GitHub
 * truncates long `run` names, so matching is tolerant in both directions. Setup
 * / post / teardown steps that have no YAML counterpart return undefined, which
 * callers treat as "fall back to job-level mapping".
 */
export function matchStepIndex(
  apiStepName: string,
  steps: Array<Record<string, unknown>>,
): number | undefined {
  const target = norm(apiStepName);
  if (target.length === 0) return undefined;
  for (let i = 0; i < steps.length; i++) {
    const derived = norm(defaultStepName(steps[i]));
    if (derived.length === 0) continue;
    if (target === derived || target.startsWith(derived) || derived.startsWith(target)) {
      return i;
    }
  }
  return undefined;
}

/**
 * Resolve a data path (e.g. `jobs.build.steps.2`) to its source location.
 * Map entries are sparse leaves (`...steps.2.run`), never the bare construct, so
 * we prefix-match every mapping under `target` and take the topmost generated
 * line — that is the first source line of the construct.
 */
export function resolvePath(map: SourceMap, target: string): ResolvedLocation | undefined {
  let best: SourceMapping | undefined;
  for (const mapping of map.mappings) {
    const path = mapping.path ?? "";
    if (path === target || path.startsWith(`${target}.`)) {
      if (!best || mapping.generated.line < best.generated.line) best = mapping;
    }
  }
  if (!best) return undefined;
  return {
    file: map.sources[best.source] ?? map.sources[0] ?? map.file,
    line: best.original.line,
    col: best.original.col,
  };
}

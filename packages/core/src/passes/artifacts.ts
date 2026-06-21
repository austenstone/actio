import { deriveNode, type Job, type Step, transformSteps, visitJobs } from "../ir.js";
import { type ParseContext, type Path, setKeyOrder } from "../parser.js";
import { asArray, isObject, pushDiagnostic, slugify, sourcePathFor } from "./helpers.js";
import type { Pass } from "./registry.js";

/**
 * Versionless `uses:` is a footgun: it floats to the action's default branch and
 * is not pinnable (pin needs an `@ref`). A tagged default keeps #96 honest.
 */
const DEFAULT_UPLOADER = "actions/upload-artifact@v4";

type ArtifactsSpec = {
  path: string;
  name?: string;
  if: string;
  retentionDays?: number;
};

/** An emitted upload's artifact name plus where it came from, for collision checks. */
type EmittedName = { name: string; path?: Path };

/** A literal that carries a `${{ ... }}` expression may differ per matrix leg at runtime. */
function hasExpression(value: string): boolean {
  return value.includes("${{");
}

function stepLabel(step: Step): string {
  if (typeof step.name === "string" && step.name.trim()) return step.name.trim();
  if (typeof step.uses === "string" && step.uses.trim()) return step.uses.trim();
  if (typeof step.run === "string") {
    const first = step.run.split("\n")[0]?.trim();
    if (first) return first;
  }
  return "step";
}

/** Join a path glob (or list of globs) into upload-artifact's multiline `path` input. */
function normalizePaths(ctx: ParseContext, raw: unknown, path?: Path): string | null {
  const list = asArray(raw)
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (list.length === 0) {
    pushDiagnostic(
      ctx,
      "error",
      "artifacts requires a non-empty `paths` (a glob string or a list of globs)",
      path,
      { hint: "e.g. `paths: dist/**` or `paths: [dist/**, coverage/**]`", code: "artifacts-paths" },
    );
    return null;
  }
  return list.join("\n");
}

function normalizeRetention(ctx: ParseContext, raw: unknown, path?: Path): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    pushDiagnostic(
      ctx,
      "error",
      `artifacts \`retention-days\` must be a positive integer (got ${JSON.stringify(raw)})`,
      path,
      { hint: "GitHub allows 1-90 days", code: "artifacts-retention" },
    );
    return undefined;
  }
  return raw;
}

function normalizeSpec(ctx: ParseContext, raw: unknown, path?: Path): ArtifactsSpec | null {
  if (!isObject(raw)) {
    pushDiagnostic(ctx, "error", "artifacts must be a mapping", path, { code: "artifacts-shape" });
    return null;
  }
  const pathInput = normalizePaths(ctx, raw.paths, path);
  if (pathInput === null) return null;
  const ifExpr = typeof raw.if === "string" && raw.if.trim() ? raw.if.trim() : "always()";
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
  return {
    path: pathInput,
    name,
    if: ifExpr,
    retentionDays: normalizeRetention(ctx, raw["retention-days"], path),
  };
}

/**
 * upload-artifact@v4 HARD-FAILS at runtime when two uploads share a name (the
 * action default is the literal `artifact`). When a step omits `name`, derive a
 * deterministic, collision-free one from the job id + step label so two
 * `artifacts:` steps never compile into a workflow that dies on the runner.
 */
function deriveName(jobId: string, step: Step, idx: number, used: Set<string>): string {
  const base = slugify(`${jobId}-${stepLabel(step)}`) || `${slugify(jobId)}-artifacts-${idx + 1}`;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}`;
  used.add(name);
  return name;
}

function buildUploadStep(
  ctx: ParseContext,
  origin: Step,
  uploader: string,
  spec: ArtifactsSpec,
  name: string,
): Step {
  const withObj: Record<string, unknown> = { name, path: spec.path };
  if (spec.retentionDays !== undefined) withObj["retention-days"] = spec.retentionDays;
  setKeyOrder(withObj, ["name", "path", "retention-days"]);

  const upload = deriveNode<Step>(ctx, origin, {
    name: "Upload artifacts",
    if: spec.if,
    uses: uploader,
    with: withObj,
  });
  setKeyOrder(upload, ["name", "if", "uses", "with"]);
  return upload;
}

function expandStep(
  ctx: ParseContext,
  jobId: string,
  step: Step,
  idx: number,
  uploader: string,
  used: Set<string>,
  hasMatrix: boolean,
  emitted: EmittedName[],
): Step[] {
  if (!isObject(step) || step.artifacts === undefined) return [step];
  const path = sourcePathFor(ctx, step, ["jobs", jobId, "steps", idx], ["artifacts"]);
  const spec = normalizeSpec(ctx, step.artifacts, path);
  delete step.artifacts;
  if (spec === null) return [step];

  let name: string;
  if (spec.name !== undefined) {
    name = spec.name;
    const namePath = sourcePathFor(ctx, step, ["jobs", jobId, "steps", idx], ["artifacts", "name"]);
    emitted.push({ name, path: namePath });
  } else {
    name = deriveName(jobId, step, idx, used);
    // One derived name is shared by every matrix leg (legs are one run), so an
    // unnamed upload in a matrix job collides at runtime. The author must add a
    // per-leg expression; warn rather than ship a silent footgun.
    if (hasMatrix) {
      pushDiagnostic(
        ctx,
        "warning",
        `artifacts: unnamed upload in matrix job "${jobId}" derives one name ("${name}") shared by every matrix leg, which collides at runtime`,
        path,
        {
          hint: "set `name:` with a per-leg expression, e.g. `name: build-${{ matrix.os }}`",
          code: "artifacts-matrix-unnamed",
        },
      );
    }
  }
  return [step, buildUploadStep(ctx, step, uploader, spec, name)];
}

/**
 * upload-artifact@v4 hard-fails at runtime when two uploads in the same run share
 * a name, and the collision boundary is the whole workflow run (across jobs).
 * Derived names dedup themselves, so the only silent collision left is two explicit
 * literal names. Skip expression-bearing names: they may differ per matrix leg.
 */
function warnDuplicateNames(ctx: ParseContext, emitted: EmittedName[]): void {
  const groups = new Map<string, (Path | undefined)[]>();
  for (const { name, path } of emitted) {
    if (hasExpression(name)) continue;
    const paths = groups.get(name) ?? [];
    paths.push(path);
    groups.set(name, paths);
  }
  for (const [name, paths] of groups) {
    if (paths.length < 2) continue;
    for (const path of paths) {
      pushDiagnostic(
        ctx,
        "warning",
        `artifacts: ${paths.length} upload steps emit the same artifact name "${name}"; upload-artifact@v4 hard-fails at runtime when uploads in a run share a name`,
        path,
        { hint: "give each `artifacts:` step a unique `name:`", code: "artifacts-duplicate-name" },
      );
    }
  }
}

function explicitNamesIn(job: Job): string[] {
  if (!Array.isArray(job.steps)) return [];
  const names: string[] = [];
  for (const step of job.steps) {
    if (!isObject(step) || !isObject(step.artifacts)) continue;
    const n = step.artifacts.name;
    if (typeof n === "string" && n.trim()) names.push(n.trim());
  }
  return names;
}

/**
 * artifacts pass: expands a step's inline `artifacts:` block into the original
 * step plus a trailing `actions/upload-artifact` step. Runs after `fragments`
 * (so injected steps expand too) and before `retry` (so a retried step fans out
 * only its run, not a duplicate uploader per attempt). The emitted `uses:` flows
 * through the later pin pass like any other action ref.
 */
export function artifactsPass(ctx: ParseContext): void {
  const uploader = ctx.internal.artifacts?.uploader?.trim() || DEFAULT_UPLOADER;

  // Seed with every explicit name first so derived names never shadow them.
  const used = new Set<string>();
  visitJobs(ctx, ({ job }) => {
    for (const n of explicitNamesIn(job)) used.add(n);
  });

  const emitted: EmittedName[] = [];
  visitJobs(ctx, ({ id: jobId, job }) => {
    if (!Array.isArray(job.steps)) return;
    const hasMatrix = isObject(job.strategy) && job.strategy.matrix !== undefined;
    transformSteps(ctx, jobId, job, (step, idx) =>
      expandStep(ctx, jobId, step, idx, uploader, used, hasMatrix, emitted),
    );
  });

  warnDuplicateNames(ctx, emitted);
}

export const artifacts: Pass = {
  name: "artifacts",
  runsAfter: ["fragments"],
  apply: artifactsPass,
};

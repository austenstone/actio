import { cloneNode, type Job, type Step } from "../ir.js";
import { type ParseContext, type Path, parseActio } from "../parser.js";
import { asStepArray, isObject, pushDiagnostic, sourcePathFor } from "./helpers.js";
import { resolveCompileTimeTextBoundaries } from "./params.js";
import type { Pass } from "./registry.js";

// Synthetic job key used to materialize a STEP-level cross-file inject: the
// target define is spliced into a throwaway one-job module, compiled in module
// scope, then its steps are lifted back into the importer.
const SYNTH_JOB = "__actio_import__";

const SELECTOR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

type Diag =
  | "import-module-not-found"
  | "import-define-not-found"
  | "import-cycle"
  | "import-local-ref-version"
  | "import-unknown-param"
  | "import-malformed-module";

function importError(ctx: ParseContext, code: Diag, message: string, path?: Path): void {
  pushDiagnostic(ctx, "error", `[${code}] ${message}`, path, { code });
}

// v1 module paths are local + relative and end in .actio.yml or .yaml. Plain
// `.yml` (without the `.actio` segment) is intentionally rejected.
function hasModuleExtension(spec: string): boolean {
  const lower = spec.toLowerCase();
  return lower.endsWith(".actio.yml") || lower.endsWith(".yaml");
}

interface Selector {
  spec: string;
  name: string;
}

/**
 * Parse and validate a `./path.actio.yml#name` selector, enforcing the v1 rules
 * (relative path, allowed extension, required `#name`, no `@ref`). Emits the
 * matching diagnostic and returns undefined on the first rule it breaks.
 */
function parseSelector(ctx: ParseContext, selector: string, path?: Path): Selector | undefined {
  const hashes = selector.split("#").length - 1;
  const hash = selector.indexOf("#");
  if (hashes !== 1 || hash < 0) {
    importError(
      ctx,
      "import-malformed-module",
      `cross-file inject "${selector}" must be of the form ./path.actio.yml#name`,
      path,
    );
    return undefined;
  }
  const spec = selector.slice(0, hash);
  const name = selector.slice(hash + 1);
  if (!SELECTOR_NAME_RE.test(name)) {
    importError(
      ctx,
      "import-malformed-module",
      `cross-file inject "${selector}" has an invalid define name after "#"`,
      path,
    );
    return undefined;
  }
  if (spec.includes("@")) {
    importError(
      ctx,
      "import-local-ref-version",
      `cross-file inject "${selector}" must not pin a version with @ref for a local path`,
      path,
    );
    return undefined;
  }
  if (!(spec.startsWith("./") || spec.startsWith("../"))) {
    importError(
      ctx,
      "import-malformed-module",
      `cross-file inject "${selector}" must use a relative path starting with ./ or ../`,
      path,
    );
    return undefined;
  }
  if (!hasModuleExtension(spec)) {
    importError(
      ctx,
      "import-malformed-module",
      `cross-file inject "${selector}" path must end in .actio.yml or .yaml`,
      path,
    );
    return undefined;
  }
  return { spec, name };
}

interface ResolvedModule {
  id: string;
  source: string;
}

/** Resolve a selector path through the injected seam, with self-contained cycle detection. */
function resolveModule(ctx: ParseContext, spec: string, path?: Path): ResolvedModule | undefined {
  const runtime = ctx.internal.modules;
  if (!runtime) {
    importError(
      ctx,
      "import-module-not-found",
      "cross-file inject needs a module resolver; none was provided",
      path,
    );
    return undefined;
  }
  const fromFile = runtime.stack.at(-1) ?? ctx.fileName;
  const resolved = runtime.resolver.resolve(spec, fromFile);
  if (!resolved) {
    importError(
      ctx,
      "import-module-not-found",
      `module "${spec}" not found (from ${fromFile})`,
      path,
    );
    return undefined;
  }
  if (runtime.stack.includes(resolved.id)) {
    importError(
      ctx,
      "import-cycle",
      `circular import detected: ${[...runtime.stack, resolved.id].join(" -> ")}`,
      path,
    );
    return undefined;
  }
  return resolved;
}

/**
 * Parse a resolved module into its own context and seed its module runtime
 * (resolver + extended cycle stack + compile hook) so nested injects keep
 * resolving in module scope. A YAML parse failure surfaces as malformed-module
 * in the importer's origin.
 */
function parseModule(
  ctx: ParseContext,
  resolved: ResolvedModule,
  path?: Path,
): ParseContext | undefined {
  const runtime = ctx.internal.modules;
  if (!runtime) return undefined;
  const modCtx = parseActio(resolved.source, resolved.id);
  if (modCtx.diagnostics.some((d) => d.severity === "error")) {
    importError(ctx, "import-malformed-module", `module "${resolved.id}" failed to parse`, path);
    return undefined;
  }
  modCtx.internal.modules = {
    resolver: runtime.resolver,
    stack: [...runtime.stack, resolved.id],
    compile: runtime.compile,
  };
  return modCtx;
}

/** Surface a compiled module's error diagnostics on the importer so nested failures are not silent. */
function forwardErrors(ctx: ParseContext, modCtx: ParseContext): void {
  for (const d of modCtx.diagnostics) {
    if (d.severity === "error") ctx.diagnostics.push(d);
  }
}

/**
 * GitLab `include:`-style deep merge: maps merge recursively, arrays and scalars
 * replace wholesale, and the override (local sibling) always wins.
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (isObject(base) && isObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      out[key] = key in out ? deepMerge(out[key], value) : value;
    }
    return out;
  }
  return override;
}

const templateParamNames = (ctx: ParseContext, name: string): Set<string> => {
  const templates = ctx.data.templates;
  const node = isObject(templates) ? templates[name] : undefined;
  const params = isObject(node) ? node.params : undefined;
  return new Set(isObject(params) ? Object.keys(params) : []);
};

/**
 * Splice a STEP-level `inject: ./lib#name` (+ optional `with:`). Resolves the
 * module, binds `with:` to the target template's params (values pre-resolved in
 * importer scope, the only importer->define channel), compiles the define in
 * module scope, and returns the inert step list. Installed on the module runtime
 * so the fragments pass can call it for both top-level and nested step injects.
 */
export function materializeStep(
  ctx: ParseContext,
  selector: string,
  step: Step,
  stepPath: Path | undefined,
): Step[] | undefined {
  const path = sourcePathFor(ctx, step, stepPath, ["inject"]);
  const parsed = parseSelector(ctx, selector, path);
  if (!parsed) return undefined;
  const resolved = resolveModule(ctx, parsed.spec, path);
  if (!resolved) return undefined;
  const modCtx = parseModule(ctx, resolved, path);
  if (!modCtx) return undefined;

  const templates = isObject(modCtx.data.templates) ? modCtx.data.templates : undefined;
  const fragments = isObject(modCtx.data.fragments) ? modCtx.data.fragments : undefined;
  const isTemplate = !!templates && parsed.name in templates;
  const isFragment = !!fragments && parsed.name in fragments;
  if (!isTemplate && !isFragment) {
    importError(
      ctx,
      "import-define-not-found",
      `define "${parsed.name}" not found in module "${resolved.id}"`,
      path,
    );
    return undefined;
  }

  const withRaw = (step as Record<string, unknown>).with;
  if (isObject(withRaw)) {
    const declared = isTemplate ? templateParamNames(modCtx, parsed.name) : new Set<string>();
    for (const key of Object.keys(withRaw)) {
      if (!declared.has(key)) {
        importError(
          ctx,
          "import-unknown-param",
          `inject "${selector}" passes unknown param "${key}" (declared: ${
            [...declared].join(", ") || "none"
          })`,
          path,
        );
        return undefined;
      }
    }
  }

  // Bind `with:` to literals in the importer's lexical scope before the module
  // pipeline runs; everything else in the define resolves in module scope.
  let boundWith: Record<string, unknown> | undefined;
  if (isObject(withRaw)) {
    boundWith = cloneNode(ctx, withRaw);
    resolveCompileTimeTextBoundaries(ctx, boundWith, path ? [...path.slice(0, -1), "with"] : []);
  }

  const injectStep: Record<string, unknown> = { inject: parsed.name };
  if (boundWith) injectStep.with = boundWith;
  modCtx.data.jobs = { [SYNTH_JOB]: { "runs-on": "ubuntu-latest", steps: [injectStep] } };

  modCtx.internal.modules?.compile?.(modCtx);
  forwardErrors(ctx, modCtx);

  const jobs = isObject(modCtx.data.jobs) ? modCtx.data.jobs : undefined;
  const job = jobs ? jobs[SYNTH_JOB] : undefined;
  return isObject(job) ? asStepArray((job as Job).steps) : [];
}

/**
 * Inline a job-body `inject: ./lib#deployJob`. The local job key stays the
 * emitted id; sibling keys deep-merge OVER the imported job (maps deep, arrays
 * replace). A job-level `with:` is not a param channel in v1 and is stripped.
 */
function materializeJob(
  ctx: ParseContext,
  jobId: string,
  jobNode: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const path: Path = ["jobs", jobId, "inject"];
  const parsed = parseSelector(ctx, jobNode.inject as string, path);
  if (!parsed) return undefined;
  const resolved = resolveModule(ctx, parsed.spec, path);
  if (!resolved) return undefined;
  const modCtx = parseModule(ctx, resolved, path);
  if (!modCtx) return undefined;

  const jobs = isObject(modCtx.data.jobs) ? modCtx.data.jobs : undefined;
  if (!jobs || !(parsed.name in jobs)) {
    importError(
      ctx,
      "import-define-not-found",
      `job "${parsed.name}" not found in module "${resolved.id}"`,
      path,
    );
    return undefined;
  }
  // Scope the module to just the target job so its unrelated jobs do not leak in.
  modCtx.data.jobs = { [parsed.name]: jobs[parsed.name] };

  modCtx.internal.modules?.compile?.(modCtx);
  forwardErrors(ctx, modCtx);

  const compiledJobs = isObject(modCtx.data.jobs) ? modCtx.data.jobs : undefined;
  const compiled = compiledJobs ? compiledJobs[parsed.name] : undefined;
  if (!isObject(compiled)) return undefined;

  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(jobNode)) {
    if (key === "inject" || key === "with") continue;
    overrides[key] = value;
  }
  return deepMerge(compiled, overrides) as Record<string, unknown>;
}

function importPassApply(ctx: ParseContext): void {
  const runtime = ctx.internal.modules;
  const jobs = ctx.data.jobs;
  if (!isObject(jobs)) return;

  if (!runtime) {
    // No seam: surface the same diagnostic the step path emits from fragments,
    // so a job-body cross-file inject fails loudly instead of leaking `inject:`.
    for (const [jobId, jobNode] of Object.entries(jobs)) {
      if (isObject(jobNode) && typeof jobNode.inject === "string") {
        importError(
          ctx,
          "import-module-not-found",
          "cross-file inject needs a module resolver; none was provided",
          ["jobs", jobId, "inject"],
        );
      }
    }
    return;
  }
  // Hand fragments the splice hook (covers nested module step injects too).
  runtime.materializeStep = materializeStep;

  for (const [jobId, jobNode] of Object.entries(jobs)) {
    if (!isObject(jobNode) || typeof jobNode.inject !== "string") continue;
    const merged = materializeJob(ctx, jobId, jobNode);
    if (merged !== undefined) jobs[jobId] = merged;
  }
}

/**
 * Cross-file import pass (#161). Runs FIRST so imported steps/jobs are spliced
 * into the tree before every other macro and the terminal pin sees them.
 */
export const importPass: Pass = { name: "import", apply: importPassApply };

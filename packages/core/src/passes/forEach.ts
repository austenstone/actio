import { cloneNode, type Job, type Step } from "../ir.js";
import { KEY_ORDER, type ParseContext, type Path, setKeyOrder } from "../parser.js";
import type { SymbolDef } from "../symbols.js";
import { asArray, isObject, pushDiagnostic, slugify } from "./helpers.js";
import { resolveCompileTimeExpressionValue, resolveCompileTimeTextBoundaries } from "./params.js";
import type { Pass } from "./registry.js";
import { freezeLoopStaticIf } from "./whenCompile.js";

type Scalar = string | number | boolean | null;
type ForEachMode = "serial-step" | "serial-jobs" | "parallel-matrix" | "parallel-variant-jobs";

interface LoopConfig {
  var?: unknown;
  in?: unknown;
  parallel?: unknown;
  as?: unknown;
  key?: unknown;
  [key: string]: unknown;
}

interface LoopSourceStaticScalar {
  kind: "static-scalar";
  values: Scalar[];
}

interface LoopSourceStaticObject {
  kind: "static-object";
  values: Record<string, unknown>[];
}

interface LoopSourceStaticStepList {
  kind: "static-step-list";
  values: Record<string, unknown>[];
}

interface LoopSourceRuntimeExpr {
  kind: "runtime-expr";
  expression: string;
}

interface LoopSourceGenerator {
  kind: "generator";
  generator: Record<string, unknown>;
}

type LoopSource =
  | LoopSourceStaticScalar
  | LoopSourceStaticObject
  | LoopSourceStaticStepList
  | LoopSourceRuntimeExpr
  | LoopSourceGenerator;

interface LoopIterationBinding {
  value: unknown;
  index: number;
  key: string | number;
  keySlug: string;
}

interface ShareProducer {
  baseName: string;
}

const COMPILE_TOKEN_RE = /(^|[^$])\{\{([\s\S]*?)\}\}/g;
const RUNTIME_EXPR_RE = /^\$\{\{[\s\S]+\}\}$/;
const COMPILE_EXPR_RE = /^\{\{([\s\S]+)\}\}$/;

const diagnosticMessage = (code: string, message: string): string => `[${code}] ${message}`;

const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const isStepRecord = (value: unknown): value is Record<string, unknown> => isObject(value);

const normalizedConfig = (value: unknown): LoopConfig | undefined => {
  if (!isObject(value)) return undefined;
  return value as LoopConfig;
};

const isRuntimeExpr = (value: string): boolean => RUNTIME_EXPR_RE.test(value.trim());

const stripCompileWrapper = (value: string): string | undefined => {
  const match = value.trim().match(COMPILE_EXPR_RE);
  return match?.[1]?.trim();
};

const normalizeBoolean = (value: unknown): boolean | undefined => {
  if (typeof value !== "boolean") return undefined;
  return value;
};

const normalizeParallel = (raw: unknown): boolean => (typeof raw === "boolean" ? raw : true);

const normalizeAs = (raw: unknown, fallback: string): string => {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const normalizeMaxParallel = (config: LoopConfig): number | undefined => {
  const raw = config["max-parallel"] ?? config.max_in_flight;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return undefined;
  return Math.floor(raw);
};

const normalizeFailFast = (config: LoopConfig): boolean | undefined => {
  const raw = config["fail-fast"] ?? config.fail_fast;
  return normalizeBoolean(raw);
};

const checkRequiredConfig = (
  ctx: ParseContext,
  path: Path,
  config: LoopConfig,
): config is LoopConfig => {
  if (typeof config.var !== "string" || config.var.trim().length === 0 || config.in === undefined) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage("for-each-missing-required", `for-each requires "var" and "in"`),
      path,
    );
    return false;
  }
  return true;
};

const resolveInlineCompileSource = (ctx: ParseContext, input: string, path: Path): unknown => {
  const expression = stripCompileWrapper(input);
  if (!expression) return input;
  const resolved = resolveCompileTimeExpressionValue(ctx, expression);
  if (!resolved.resolved) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-in-invalid",
        `for-each "in" must be a list, object, params reference, or output expression`,
      ),
      path,
    );
    return undefined;
  }
  return resolved.value;
};

const resolveLoopSource = (
  ctx: ParseContext,
  input: unknown,
  path: Path,
): LoopSource | undefined => {
  if (Array.isArray(input)) {
    if (input.every(isScalar)) return { kind: "static-scalar", values: [...input] };
    if (input.every((value) => isObject(value))) {
      return {
        kind: "static-object",
        values: input.map((value) => structuredClone(value as Record<string, unknown>)),
      };
    }
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-in-invalid",
        `for-each "in" must be a list, object, params reference, or output expression`,
      ),
      path,
    );
    return undefined;
  }

  if (isObject(input)) {
    if (typeof input.run === "string" || typeof input.script === "string") {
      return { kind: "generator", generator: structuredClone(input) };
    }
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-in-invalid",
        `for-each "in" must be a list, object, params reference, or output expression`,
      ),
      path,
    );
    return undefined;
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "for-each-in-invalid",
          `for-each "in" must be a list, object, params reference, or output expression`,
        ),
        path,
      );
      return undefined;
    }
    if (isRuntimeExpr(trimmed)) return { kind: "runtime-expr", expression: trimmed };

    const resolvedCompile = resolveInlineCompileSource(ctx, trimmed, path);
    if (resolvedCompile === undefined) return undefined;
    if (resolvedCompile !== input) return resolveLoopSource(ctx, resolvedCompile, path);

    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage("for-each-in-scalar", `for-each "in" must be a list, not a scalar value`),
      path,
    );
    return undefined;
  }

  pushDiagnostic(
    ctx,
    "error",
    diagnosticMessage(
      "for-each-in-invalid",
      `for-each "in" must be a list, object, params reference, or output expression`,
    ),
    path,
  );
  return undefined;
};

const collectShareProducers = (value: unknown): ShareProducer[] => {
  const producers: ShareProducer[] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (!isObject(node)) return;
    if (Object.hasOwn(node, "share")) {
      const shareValue = node.share;
      if (typeof shareValue === "string" && shareValue.trim().length > 0) {
        producers.push({ baseName: shareValue.trim() });
      } else if (isObject(shareValue)) {
        const base =
          typeof shareValue.name === "string"
            ? shareValue.name
            : typeof shareValue.output === "string"
              ? shareValue.output
              : typeof shareValue.as === "string"
                ? shareValue.as
                : undefined;
        producers.push({ baseName: base?.trim() || "shared" });
      } else {
        producers.push({ baseName: "shared" });
      }
    }
    for (const child of Object.values(node)) visit(child);
  };

  visit(value);
  return producers;
};

const collectUsedLoopFields = (value: unknown, varName: string): Set<string> => {
  const fields = new Set<string>();

  const scanString = (text: string): void => {
    COMPILE_TOKEN_RE.lastIndex = 0;
    let match = COMPILE_TOKEN_RE.exec(text);
    while (match) {
      const expression = match[2]?.trim() ?? "";
      if (expression.startsWith(`${varName}.`)) {
        const segments = expression.split(".");
        const firstField = segments[1]?.trim();
        if (firstField) fields.add(firstField);
      }
      match = COMPILE_TOKEN_RE.exec(text);
    }
  };

  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      scanString(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (!isObject(node)) return;
    for (const child of Object.values(node)) visit(child);
  };

  visit(value);
  return fields;
};

const validateObjectFields = (
  ctx: ParseContext,
  path: Path,
  varName: string,
  body: unknown,
  items: Record<string, unknown>[],
): boolean => {
  const requiredFields = collectUsedLoopFields(body, varName);
  if (requiredFields.size === 0) return true;

  let ok = true;
  for (const field of requiredFields) {
    const missingIndex = items.findIndex((item) => !Object.hasOwn(item, field));
    if (missingIndex >= 0) {
      ok = false;
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "for-each-param-field-missing",
          `loop element has no field "${field}" (required by {{ ${varName}.${field} }})`,
        ),
        path,
      );
    }
  }
  return ok;
};

const withScopedSymbols = <T>(ctx: ParseContext, symbols: SymbolDef[], apply: () => T): T => {
  const previous = new Map<string, SymbolDef | undefined>();
  for (const symbol of symbols) {
    previous.set(symbol.name, ctx.symbols.get(symbol.name));
    ctx.symbols.set(symbol.name, symbol);
  }
  try {
    return apply();
  } finally {
    for (const symbol of symbols) {
      const existing = previous.get(symbol.name);
      if (existing) ctx.symbols.set(symbol.name, existing);
      else ctx.symbols.delete(symbol.name);
    }
  }
};

const matrixSymbol = (name: string, value: unknown): SymbolDef => ({
  name,
  kind: "shared-output",
  type: "object",
  compileTimeKnown: true,
  valueKnown: true,
  hasDefault: false,
  required: false,
  taint: { tainted: false, derivedFrom: [] },
  value,
});

const bindingSymbols = (
  varName: string,
  binding: LoopIterationBinding,
  matrixRef?: string | Record<string, string>,
): SymbolDef[] => {
  const value = matrixRef ?? binding.value;
  const keyValue = typeof matrixRef === "string" ? matrixRef : String(binding.key);
  const indexValue = typeof matrixRef === "string" ? matrixRef : binding.index;
  return [
    matrixSymbol(varName, value),
    matrixSymbol(`for-each.${varName}`, value),
    matrixSymbol("key", keyValue),
    matrixSymbol("index", indexValue),
  ];
};

const buildBindings = (
  source: LoopSourceStaticScalar | LoopSourceStaticObject | LoopSourceStaticStepList,
): LoopIterationBinding[] => {
  const slugCounts = new Map<string, number>();
  return source.values.map((value, index) => {
    const key = index;
    const baseSlug =
      source.kind === "static-scalar" && typeof value === "string"
        ? slugify(value)
        : source.kind === "static-scalar" && typeof value === "number"
          ? slugify(String(value))
          : source.kind === "static-scalar" && typeof value === "boolean"
            ? slugify(String(value))
            : "";
    const slugSeed = baseSlug.length > 0 ? baseSlug : String(index);
    const seen = (slugCounts.get(slugSeed) ?? 0) + 1;
    slugCounts.set(slugSeed, seen);
    const keySlug = seen === 1 ? slugSeed : `${slugSeed}_${seen}`;
    return { value, index, key, keySlug };
  });
};

const applyCompileSubstitution = (ctx: ParseContext, value: unknown, path: Path): void => {
  resolveCompileTimeTextBoundaries(ctx, value, path);
};

const maybeWarnSerialOnlyKnob = (ctx: ParseContext, config: LoopConfig, path: Path): void => {
  const keys: Array<[string, unknown]> = [
    ["fail-fast", config["fail-fast"]],
    ["fail_fast", config.fail_fast],
    ["max-parallel", config["max-parallel"]],
    ["max_in_flight", config.max_in_flight],
    ["as", config.as],
  ];
  for (const [key, value] of keys) {
    if (value === undefined) continue;
    pushDiagnostic(
      ctx,
      "warning",
      diagnosticMessage(
        "for-each-serial-option-ignored",
        `"${key}" only applies to parallel for-each; ignoring`,
      ),
      [...path, key],
    );
  }
};

const collectBodySteps = (step: Step): unknown[] => {
  const body = step.steps;
  return Array.isArray(body) ? structuredClone(body) : [];
};

const expandStepPlaceholder = (
  raw: unknown,
  varName: string,
  value: Record<string, unknown>,
): Step[] => {
  if (!Array.isArray(raw) || raw.length !== 1 || typeof raw[0] !== "string") return [];
  const token = raw[0].trim();
  const asCompile = stripCompileWrapper(token);
  if (asCompile === varName || token === varName) {
    return [structuredClone(value)];
  }
  return [];
};

const hasInject = (steps: unknown[]): boolean =>
  steps.some((step) => isObject(step) && typeof step.inject === "string");

const expandLoopInSteps = (
  ctx: ParseContext,
  jobId: string,
  steps: Step[],
  path: Path,
  scopeVars: string[],
): Step[] => {
  const out: Step[] = [];

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (step === undefined) continue;
    if (!isObject(step) || !Object.hasOwn(step, "for-each")) {
      out.push(step);
      continue;
    }

    const config = normalizedConfig(step["for-each"]);
    if (!config) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage("for-each-shape", "for-each must be a mapping"),
        [...path, index, "for-each"],
      );
      continue;
    }
    if (!checkRequiredConfig(ctx, [...path, index, "for-each"], config)) continue;
    const varName = String(config.var).trim();
    if (scopeVars.includes(varName)) {
      pushDiagnostic(
        ctx,
        "warning",
        diagnosticMessage(
          "for-each-shadow",
          `loop variable "${varName}" shadows an outer for-each`,
        ),
        [...path, index, "for-each", "var"],
      );
    }

    if (config.parallel === true) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "for-each-step-parallel",
          "parallel for-each must be job-level; a step block can only expand serially",
        ),
        [...path, index, "for-each", "parallel"],
      );
      continue;
    }

    const source = resolveLoopSource(ctx, config.in, [...path, index, "for-each", "in"]);
    if (!source) continue;
    if (source.kind === "runtime-expr" || source.kind === "generator") {
      // A whole-job runtime loop (the job's only step) is auto-rewritten upstream
      // in `tryRewriteWholeJobRuntimeLoop`. Anything reaching here is genuinely
      // partial/multi/nested: a runtime loop sharing the job with other steps, or
      // nested inside another loop's body. GHA has no step-level matrix, so a
      // partial hoist onto a fresh matrix runner can't be proven to preserve
      // shared workspace state, cross-step outputs, or run-once side effects —
      // stay fail-loud rather than silently miscompile.
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "for-each-step-runtime-partial",
          "for-each over a runtime list can auto-expand only when it is the job's sole step (it becomes a native matrix job). This job has a non-looped neighbor (e.g. checkout/install) or a nested loop — move the non-looped steps to their own job, or make the whole job the loop, or use a compile-time list",
        ),
        [...path, index, "for-each", "in"],
      );
      continue;
    }

    maybeWarnSerialOnlyKnob(ctx, config, [...path, index, "for-each"]);

    const rawBody = collectBodySteps(step);
    if (hasInject(rawBody)) {
      pushDiagnostic(
        ctx,
        "warning",
        diagnosticMessage(
          "for-each-fragment-loopvar",
          "TODO(for-each-fragment-loopvar): loop-var {{ var }} substitution happens before fragment injection",
        ),
        [...path, index, "steps"],
      );
    }

    const bindings = buildBindings(source);
    if (bindings.length === 0) {
      pushDiagnostic(
        ctx,
        "warning",
        diagnosticMessage(
          "for-each-empty-literal",
          `for-each "in" is empty; the loop expands to nothing`,
        ),
        [...path, index, "for-each", "in"],
      );
      continue;
    }

    if (
      source.kind === "static-object" &&
      !validateObjectFields(
        ctx,
        [...path, index, "for-each", "in"],
        varName,
        rawBody,
        source.values,
      )
    ) {
      continue;
    }

    for (const binding of bindings) {
      const symbols = bindingSymbols(varName, binding);
      const rendered = withScopedSymbols(ctx, symbols, () => {
        let bodyOut: Step[] | undefined;
        if (source.kind === "static-step-list") {
          const placeholder = expandStepPlaceholder(
            rawBody,
            varName,
            source.values[binding.index] ?? {},
          );
          if (placeholder.length > 0) bodyOut = placeholder;
        }
        if (bodyOut === undefined) {
          const body = structuredClone(rawBody);
          applyCompileSubstitution(ctx, body, [...path, index, "steps"]);
          const bodySteps = asArray(body).filter(isStepRecord) as Step[];
          bodyOut = expandLoopInSteps(
            ctx,
            jobId,
            bodySteps,
            [...path, index, "steps"],
            [...scopeVars, varName],
          );
        }
        freezeLoopStaticIf(ctx, bodyOut, [...path, index, "steps"], varName);
        return bodyOut;
      });
      out.push(...rendered);
    }
  }
  return out;
};

const setMatrixFailFastAndMaxParallel = (
  strategy: Record<string, unknown>,
  config: LoopConfig,
): void => {
  const failFast = normalizeFailFast(config);
  strategy["fail-fast"] = failFast ?? false;
  const maxParallel = normalizeMaxParallel(config);
  if (maxParallel !== undefined) {
    strategy["max-parallel"] = maxParallel;
  }
};

const matrixSymbolObjectFromInclude = (
  include: Record<string, unknown>[],
): Record<string, string> => {
  const keys = new Set<string>();
  for (const entry of include) {
    for (const key of Object.keys(entry)) keys.add(key);
  }
  const out: Record<string, string> = {};
  for (const key of keys) out[key] = `\${{ matrix.${key} }}`;
  return out;
};

const recordShareContract = (
  ctx: ParseContext,
  jobId: string,
  mode: ForEachMode,
  bindings: LoopIterationBinding[],
  producers: ShareProducer[],
  dynamic: boolean,
): void => {
  if (producers.length === 0) return;
  const entries = bindings.flatMap((binding) =>
    producers.map((producer) => ({
      keySlug: binding.keySlug,
      outputName: `${producer.baseName}_${binding.keySlug}`,
    })),
  );
  if (!ctx.internal.forEachShareContracts) ctx.internal.forEachShareContracts = [];
  ctx.internal.forEachShareContracts.push({ jobId, mode, dynamic, entries });
};

const normalizeNeedsArray = (needs: unknown): string[] => {
  if (typeof needs === "string") return [needs];
  if (Array.isArray(needs))
    return needs.filter((entry): entry is string => typeof entry === "string");
  return [];
};

const buildSerialSiblingJobs = (
  ctx: ParseContext,
  jobId: string,
  job: Job,
  config: LoopConfig,
  source: LoopSourceStaticScalar,
  loopVar: string,
  path: Path,
): Record<string, Job> | undefined => {
  const bindings = buildBindings(source);
  if (bindings.length === 0) {
    pushDiagnostic(
      ctx,
      "warning",
      diagnosticMessage(
        "for-each-empty-literal",
        `for-each "in" is empty; the loop expands to nothing`,
      ),
      [...path, "in"],
    );
    return {};
  }

  const jobs: Record<string, Job> = {};
  const originalNeeds = normalizeNeedsArray(job.needs);
  let previousId: string | undefined;
  const seenIds = new Set<string>();

  for (const binding of bindings) {
    const slug = slugify(String(binding.value)) || String(binding.index);
    const siblingId = `${jobId}-${slug}`;
    if (seenIds.has(siblingId)) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "for-each-job-id-collision",
          `for-each generates duplicate job id "${siblingId}"`,
        ),
        path,
      );
      return undefined;
    }
    seenIds.add(siblingId);

    const sibling = cloneNode(ctx, job);
    delete sibling["for-each"];
    sibling.needs = previousId ? [previousId] : originalNeeds;

    const symbols = bindingSymbols(loopVar, binding);
    withScopedSymbols(ctx, symbols, () => {
      applyCompileSubstitution(ctx, sibling, ["jobs", jobId]);
      if (Array.isArray(sibling.steps)) {
        sibling.steps = expandLoopInSteps(
          ctx,
          siblingId,
          sibling.steps,
          ["jobs", siblingId, "steps"],
          [loopVar],
        );
      }
      freezeLoopStaticIf(ctx, sibling, ["jobs", siblingId], loopVar);
    });
    jobs[siblingId] = sibling;
    previousId = siblingId;
  }

  const shareProducers = collectShareProducers(job.steps ?? []);
  recordShareContract(ctx, jobId, "serial-jobs", bindings, shareProducers, false);
  maybeWarnSerialOnlyKnob(ctx, config, path);
  return jobs;
};

const authorMatrixKeys = (matrix: Record<string, unknown>): Set<string> => {
  const keys = new Set<string>();
  for (const key of Object.keys(matrix)) {
    if (key === "include" || key === "exclude") continue;
    keys.add(key);
  }
  for (const listKey of ["include", "exclude"] as const) {
    const list = matrix[listKey];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (isObject(entry)) for (const key of Object.keys(entry)) keys.add(key);
    }
  }
  return keys;
};

const VARIANT_ID_FIELDS = ["key", "name", "id", "slug"] as const;

const isSlugValue = (value: unknown): boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const deriveVariantSlug = (
  ctx: ParseContext,
  config: LoopConfig,
  binding: LoopIterationBinding,
  source: LoopSourceStaticScalar | LoopSourceStaticObject,
  path: Path,
): string => {
  if (source.kind === "static-scalar") {
    return slugify(String(binding.value)) || String(binding.index);
  }
  const obj = isObject(binding.value) ? binding.value : {};
  const configured = typeof config.key === "string" ? config.key.trim() : "";
  const field =
    configured && Object.hasOwn(obj, configured) && isSlugValue(obj[configured])
      ? configured
      : VARIANT_ID_FIELDS.find((f) => Object.hasOwn(obj, f) && isSlugValue(obj[f]));
  if (field) {
    const slug = slugify(String(obj[field]));
    if (slug.length > 0) return slug;
  }
  pushDiagnostic(
    ctx,
    "warning",
    diagnosticMessage(
      "for-each-variant-id-fallback",
      `object variant has no usable slug field (tried ${configured ? `"${configured}", ` : ""}key/name/id/slug); using index ${binding.index} for the job id`,
    ),
    path,
  );
  return String(binding.index);
};

const warnCoexistKnobsIgnored = (ctx: ParseContext, config: LoopConfig, path: Path): void => {
  const keys: Array<[string, unknown]> = [
    ["fail-fast", config["fail-fast"]],
    ["fail_fast", config.fail_fast],
    ["max-parallel", config["max-parallel"]],
    ["max_in_flight", config.max_in_flight],
    ["as", config.as],
  ];
  for (const [key, value] of keys) {
    if (value === undefined) continue;
    pushDiagnostic(
      ctx,
      "warning",
      diagnosticMessage(
        "for-each-loop-knob-ignored-coexist",
        `"${key}" can't target a for-each that multiplies a job with its own strategy.matrix (variants become separate jobs); ignoring`,
      ),
      [...path, key],
    );
  }
};

/**
 * Issue #79: a parallel job-level `for-each` on a job that ALSO has an
 * author-written `strategy.matrix`. Rather than folding the variant into that
 * matrix (one combined job, one status check), clone the job once per variant
 * so each keeps its full matrix — producing N separate jobs / status checks,
 * matching hand-written `test-<variant>` clusters. Mirrors
 * `buildSerialSiblingJobs` but parallel (every sibling keeps the original
 * `needs`, no chain) and preserves each clone's `strategy.matrix`.
 */
const buildParallelVariantJobs = (
  ctx: ParseContext,
  jobId: string,
  job: Job,
  config: LoopConfig,
  source: LoopSourceStaticScalar | LoopSourceStaticObject,
  loopVar: string,
  path: Path,
): Record<string, Job> | undefined => {
  const asName = normalizeAs(config.as, loopVar);
  const strategy = job.strategy as Record<string, unknown>;
  const matrix = strategy.matrix as Record<string, unknown>;

  const matrixKeys = authorMatrixKeys(matrix);
  for (const name of new Set([loopVar, asName])) {
    if (!matrixKeys.has(name)) continue;
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-matrix-key-collision",
        `for-each variable "${name}" reuses strategy.matrix key "${name}"; rename the loop with "as:" so the variant and the matrix axis stay distinct`,
      ),
      path,
    );
    return { [jobId]: job };
  }

  const bindings = buildBindings(source);
  if (bindings.length === 0) {
    pushDiagnostic(
      ctx,
      "warning",
      diagnosticMessage(
        "for-each-empty-literal",
        `for-each "in" is empty; the loop expands to nothing`,
      ),
      [...path, "in"],
    );
    return {};
  }

  warnCoexistKnobsIgnored(ctx, config, path);

  const jobs: Record<string, Job> = {};
  const seenIds = new Set<string>();
  for (const binding of bindings) {
    const slug = deriveVariantSlug(ctx, config, binding, source, [...path, "in"]);
    const siblingId = `${jobId}-${slug}`;
    if (seenIds.has(siblingId)) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "for-each-job-id-collision",
          `for-each generates duplicate job id "${siblingId}"`,
        ),
        path,
      );
      return undefined;
    }
    seenIds.add(siblingId);

    const sibling = cloneNode(ctx, job);
    delete sibling["for-each"];

    const symbols = bindingSymbols(loopVar, binding);
    withScopedSymbols(ctx, symbols, () => {
      applyCompileSubstitution(ctx, sibling, ["jobs", jobId]);
    });
    if (Array.isArray(sibling.steps)) {
      sibling.steps = expandLoopInSteps(
        ctx,
        siblingId,
        sibling.steps,
        ["jobs", siblingId, "steps"],
        [loopVar],
      );
    }
    jobs[siblingId] = sibling;
  }

  const producers = collectShareProducers(job.steps ?? []);
  recordShareContract(ctx, jobId, "parallel-variant-jobs", bindings, producers, false);
  return jobs;
};

const applyParallelMatrixLoop = (
  ctx: ParseContext,
  jobId: string,
  job: Job,
  config: LoopConfig,
  source: LoopSourceStaticScalar | LoopSourceStaticObject,
  loopVar: string,
): void => {
  delete job["for-each"];
  const asName = normalizeAs(config.as, loopVar);
  const strategy = isObject(job.strategy) ? { ...job.strategy } : {};
  const matrix = isObject(strategy.matrix) ? { ...strategy.matrix } : {};

  if (source.kind === "static-scalar") {
    matrix[asName] = structuredClone(source.values);
  } else {
    matrix.include = structuredClone(source.values);
  }

  strategy.matrix = matrix;
  setMatrixFailFastAndMaxParallel(strategy, config);
  job.strategy = strategy;

  const bindings = buildBindings(source);
  const symbols =
    source.kind === "static-scalar"
      ? [
          matrixSymbol(loopVar, `\${{ matrix.${asName} }}`),
          matrixSymbol(`for-each.${loopVar}`, `\${{ matrix.${asName} }}`),
          matrixSymbol("index", `\${{ matrix.${asName} }}`),
          matrixSymbol("key", `\${{ matrix.${asName} }}`),
        ]
      : [
          matrixSymbol(loopVar, matrixSymbolObjectFromInclude(source.values)),
          matrixSymbol(`for-each.${loopVar}`, matrixSymbolObjectFromInclude(source.values)),
          matrixSymbol("index", `\${{ matrix.${asName} }}`),
          matrixSymbol("key", `\${{ matrix.${asName} }}`),
        ];

  withScopedSymbols(ctx, symbols, () => {
    applyCompileSubstitution(ctx, job, ["jobs", jobId]);
  });

  if (Array.isArray(job.steps)) {
    job.steps = expandLoopInSteps(ctx, jobId, job.steps, ["jobs", jobId, "steps"], [loopVar]);
  }
  const producers = collectShareProducers(job.steps ?? []);
  recordShareContract(ctx, jobId, "parallel-matrix", bindings, producers, false);
};

const applyDynamicDelegation = (
  ctx: ParseContext,
  jobId: string,
  job: Job,
  config: LoopConfig,
  source: LoopSourceRuntimeExpr | LoopSourceGenerator,
  loopVar: string,
  path: Path,
): void => {
  const producers = collectShareProducers(job.steps ?? []);
  if (producers.length > 0) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "E-share-in-dynamic-loop",
        "share: inside a runtime-list for-each can't emit per-iteration outputs (matrix outputs are last-leg-wins); make the list static or await v2 artifact fan-in",
      ),
      path,
    );
    return;
  }

  delete job["for-each"];
  const asName = normalizeAs(config.as, loopVar);
  const failFast = normalizeFailFast(config);
  const dynamicBlock: Record<string, unknown> =
    source.kind === "generator"
      ? { ...source.generator, alias: asName, "fail-fast": failFast ?? false }
      : {
          alias: asName,
          "fail-fast": failFast ?? false,
          script: `echo '${source.expression}'`,
        };
  job["dynamic-matrix"] = dynamicBlock;

  const strategy = isObject(job.strategy) ? { ...job.strategy } : {};
  const maxParallel = normalizeMaxParallel(config);
  if (maxParallel !== undefined) strategy["max-parallel"] = maxParallel;
  if (Object.keys(strategy).length > 0) job.strategy = strategy;

  recordShareContract(ctx, jobId, "parallel-matrix", [], producers, true);
};

const processJobLoop = (
  ctx: ParseContext,
  jobId: string,
  job: Job,
): Record<string, Job> | undefined => {
  const config = normalizedConfig(job["for-each"]);
  if (!config) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage("for-each-shape", "for-each must be a mapping"),
      ["jobs", jobId, "for-each"],
    );
    return { [jobId]: job };
  }
  if (!checkRequiredConfig(ctx, ["jobs", jobId, "for-each"], config)) return { [jobId]: job };
  const loopVar = String(config.var).trim();
  const source = resolveLoopSource(ctx, config.in, ["jobs", jobId, "for-each", "in"]);
  if (!source) return { [jobId]: job };

  if (job["dynamic-matrix"] != null) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-dynamic-matrix-collision",
        "job already defines a matrix; remove dynamic-matrix or for-each",
      ),
      ["jobs", jobId, "for-each"],
    );
    return { [jobId]: job };
  }

  const parallel = normalizeParallel(config.parallel);
  if (!parallel) {
    if (source.kind !== "static-scalar") {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "for-each-serial-job-source",
          "serial job fan-out needs a scalar literal list (can't derive job ids)",
        ),
        ["jobs", jobId, "for-each", "in"],
      );
      return { [jobId]: job };
    }
    return buildSerialSiblingJobs(ctx, jobId, job, config, source, loopVar, [
      "jobs",
      jobId,
      "for-each",
    ]);
  }

  if (source.kind === "runtime-expr" || source.kind === "generator") {
    applyDynamicDelegation(ctx, jobId, job, config, source, loopVar, ["jobs", jobId, "for-each"]);
    return { [jobId]: job };
  }

  if (source.kind === "static-step-list") {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-job-step-list",
        `for-each "in" must be a scalar/object list at job scope`,
      ),
      ["jobs", jobId, "for-each", "in"],
    );
    return { [jobId]: job };
  }

  if (source.kind === "static-scalar" && source.values.length === 0) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-empty-parallel",
        `for-each "in" is empty; parallel literal loops would emit an invalid empty matrix`,
      ),
      ["jobs", jobId, "for-each", "in"],
    );
    delete job["for-each"];
    return { [jobId]: job };
  }

  if (
    source.kind === "static-object" &&
    !validateObjectFields(ctx, ["jobs", jobId, "for-each", "in"], loopVar, job, source.values)
  ) {
    return { [jobId]: job };
  }

  const hasAuthorMatrix =
    isObject(job.strategy) && isObject((job.strategy as Record<string, unknown>).matrix);
  if (hasAuthorMatrix) {
    return buildParallelVariantJobs(ctx, jobId, job, config, source, loopVar, [
      "jobs",
      jobId,
      "for-each",
    ]);
  }

  applyParallelMatrixLoop(ctx, jobId, job, config, source, loopVar);
  return { [jobId]: job };
};

/**
 * Case A (issue #50): a job whose entire body is exactly one runtime/generator
 * `for-each` step has a safe native target — a matrix job that is semantically
 * identical to a job-level runtime loop (one job, every iteration a full job
 * run). Detect that shape and reuse the proven job-level dynamic-delegation path
 * (`applyDynamicDelegation` -> the `dynamic-matrix` pass) instead of failing
 * loud. Returns `true` when this owns the job (rewrote it OR raised a fail-loud
 * diagnostic); `false` to let the normal serial step-loop expansion proceed.
 *
 * Everything other than this single-block whole-job shape — partial loops,
 * multiple loops, nested runtime loops, a pre-existing matrix, or `share:` in
 * the body — stays fail-loud. GHA has no step-level matrix, so a partial hoist
 * onto a fresh matrix runner cannot be proven to preserve shared workspace/
 * runner state, cross-step outputs, or run-once side effects. Bounding the safe
 * subset (and failing loud everywhere else) is what preserves the no-silent-
 * miscompile invariant. See the PR for #50 for the full rationale.
 */
const tryRewriteWholeJobRuntimeLoop = (ctx: ParseContext, jobId: string, job: Job): boolean => {
  const steps = job.steps;
  if (!Array.isArray(steps) || steps.length !== 1) return false;
  const step = steps[0];
  if (!isObject(step) || !Object.hasOwn(step, "for-each")) return false;

  const config = normalizedConfig(step["for-each"]);
  if (!config) return false; // shape error: let expandLoopInSteps own the diagnostic.

  const inValue = config.in;
  const cheapIsRuntime =
    (typeof inValue === "string" && isRuntimeExpr(inValue)) ||
    (isObject(inValue) && (typeof inValue.run === "string" || typeof inValue.script === "string"));
  if (!cheapIsRuntime) return false; // static/invalid: expandLoopInSteps is the authority.

  // From here we OWN the job: every path either rewrites it or fails loud.
  const forEachPath: Path = ["jobs", jobId, "steps", 0, "for-each"];
  if (!checkRequiredConfig(ctx, forEachPath, config)) return true;
  const varName = String(config.var).trim();

  const hasMatrix =
    isObject(job.strategy) && (job.strategy as Record<string, unknown>).matrix != null;
  if (hasMatrix || job["dynamic-matrix"] != null) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-dynamic-matrix-collision",
        "job already defines a matrix; a runtime step loop can't add a second one — remove the existing strategy.matrix/dynamic-matrix or lift the loop to its own job",
      ),
      forEachPath,
    );
    job.steps = []; // drop the un-expandable loop step so it doesn't cascade downstream.
    return true;
  }

  if (!normalizeParallel(config.parallel)) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-step-runtime",
        "for-each over a runtime list must run as a parallel matrix; a serial (parallel: false) step loop needs a compile-time list",
      ),
      [...forEachPath, "parallel"],
    );
    job.steps = []; // drop the un-expandable loop step so it doesn't cascade downstream.
    return true;
  }

  const source = resolveLoopSource(ctx, inValue, [...forEachPath, "in"]);
  if (!source) return true;
  if (source.kind !== "runtime-expr" && source.kind !== "generator") return false;

  // Hoist the loop body up to the job and rewrite the step-loop `{{ var }}` UX
  // into the matrix reference the delegated job exposes. The job-level runtime
  // path skips this step because its UX already authors `${{ matrix.<as> }}`
  // directly; the step-loop path uses `{{ var }}`, so we bridge it here.
  const asName = normalizeAs(config.as, varName);
  const matrixRef = `\${{ matrix.${asName} }}`;
  job.steps = collectBodySteps(step).filter(isStepRecord) as Step[];
  const symbols = [
    matrixSymbol(varName, matrixRef),
    matrixSymbol(`for-each.${varName}`, matrixRef),
    matrixSymbol("index", matrixRef),
    matrixSymbol("key", matrixRef),
  ];
  withScopedSymbols(ctx, symbols, () => {
    applyCompileSubstitution(ctx, job.steps, ["jobs", jobId, "steps"]);
  });
  // Expand nested *static* loops in the hoisted body now: the job-level path
  // relies on the later `processStepLoopsForJob` call for this, but we return
  // early. A nested *runtime* loop here fails loud via `for-each-step-runtime-partial`.
  if (Array.isArray(job.steps)) {
    job.steps = expandLoopInSteps(ctx, jobId, job.steps, ["jobs", jobId, "steps"], [varName]);
  }
  // Reuse the job-level delegation verbatim: it sets `job.dynamic-matrix` and
  // guards `share:` producers (Case E -> `E-share-in-dynamic-loop`). The later
  // `dynamic-matrix` pass builds the setup job, `fromJSON` matrix, empty-list
  // guard, and fail-fast default.
  applyDynamicDelegation(ctx, jobId, job, config, source, varName, forEachPath);
  return true;
};

const processStepLoopsForJob = (ctx: ParseContext, jobId: string, job: Job): void => {
  if (!Array.isArray(job.steps)) return;
  if (tryRewriteWholeJobRuntimeLoop(ctx, jobId, job)) return;
  job.steps = expandLoopInSteps(ctx, jobId, job.steps, ["jobs", jobId, "steps"], []);
};

export const forEachPass = (ctx: ParseContext): void => {
  const jobs = ctx.data.jobs;
  if (!isObject(jobs)) return;

  const recorded = (jobs as Record<symbol, unknown>)[KEY_ORDER] as string[] | undefined;
  const seen = new Set(recorded ?? []);
  const order = recorded
    ? [...recorded.filter((id) => id in jobs), ...Object.keys(jobs).filter((id) => !seen.has(id))]
    : Object.keys(jobs);

  const rebuilt: Record<string, unknown> = {};
  const rebuiltOrder: string[] = [];
  for (const jobId of order) {
    const raw = (jobs as Record<string, unknown>)[jobId];
    if (!isObject(raw)) {
      rebuilt[jobId] = raw;
      rebuiltOrder.push(jobId);
      continue;
    }
    const job = raw as Job;
    const transformed = Object.hasOwn(job, "for-each")
      ? processJobLoop(ctx, jobId, job)
      : { [jobId]: job };
    if (!transformed) continue;

    for (const [nextId, nextJobRaw] of Object.entries(transformed)) {
      if (!isObject(nextJobRaw)) continue;
      const nextJob = nextJobRaw as Job;
      processStepLoopsForJob(ctx, nextId, nextJob);
      rebuilt[nextId] = nextJob;
      rebuiltOrder.push(nextId);
    }
  }

  setKeyOrder(rebuilt, rebuiltOrder);
  ctx.data.jobs = rebuilt;
};

// TODO(share-foreach-integration): #18 consumes ctx.internal.forEachShareContracts in the joint seam.
export const forEach: Pass = {
  name: "for-each",
  runsAfter: ["params", "job-defaults"],
  apply: forEachPass,
};

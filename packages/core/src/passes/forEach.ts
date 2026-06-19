import { cloneNode, type Job, type Step } from "../ir.js";
import { KEY_ORDER, type ParseContext, type Path, setKeyOrder } from "../parser.js";
import type { SymbolDef } from "../symbols.js";
import { asArray, isObject, pushDiagnostic, slugify } from "./helpers.js";
import { resolveCompileTimeExpressionValue, resolveCompileTimeTextBoundaries } from "./params.js";
import type { Pass } from "./registry.js";

type Scalar = string | number | boolean | null;
type ForEachMode = "serial-step" | "serial-jobs" | "parallel-matrix";

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
      diagnosticMessage("for-each-missing-required", `for_each requires "var" and "in"`),
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
        `for_each "in" must be a list, object, params reference, or output expression`,
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
        `for_each "in" must be a list, object, params reference, or output expression`,
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
        `for_each "in" must be a list, object, params reference, or output expression`,
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
          `for_each "in" must be a list, object, params reference, or output expression`,
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
      diagnosticMessage("for-each-in-scalar", `for_each "in" must be a list, not a scalar value`),
      path,
    );
    return undefined;
  }

  pushDiagnostic(
    ctx,
    "error",
    diagnosticMessage(
      "for-each-in-invalid",
      `for_each "in" must be a list, object, params reference, or output expression`,
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
    matrixSymbol(`for_each.${varName}`, value),
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
        `"${key}" only applies to parallel for_each; ignoring`,
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
    if (!isObject(step) || !Object.hasOwn(step, "for_each")) {
      out.push(step);
      continue;
    }

    const config = normalizedConfig(step.for_each);
    if (!config) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage("for-each-shape", "for_each must be a mapping"),
        [...path, index, "for_each"],
      );
      continue;
    }
    if (!checkRequiredConfig(ctx, [...path, index, "for_each"], config)) continue;
    const varName = String(config.var).trim();
    if (scopeVars.includes(varName)) {
      pushDiagnostic(
        ctx,
        "warning",
        diagnosticMessage(
          "for-each-shadow",
          `loop variable "${varName}" shadows an outer for_each`,
        ),
        [...path, index, "for_each", "var"],
      );
    }

    if (config.parallel === true) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "for-each-step-parallel",
          "parallel for_each must be job-level; a step block can only expand serially",
        ),
        [...path, index, "for_each", "parallel"],
      );
      continue;
    }

    const source = resolveLoopSource(ctx, config.in, [...path, index, "for_each", "in"]);
    if (!source) continue;
    if (source.kind === "runtime-expr" || source.kind === "generator") {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "for-each-step-runtime",
          "for_each over a runtime list requires a parallel job (matrix); a serial step loop needs a compile-time list",
        ),
        [...path, index, "for_each", "in"],
      );
      continue;
    }

    maybeWarnSerialOnlyKnob(ctx, config, [...path, index, "for_each"]);

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
          `for_each "in" is empty; the loop expands to nothing`,
        ),
        [...path, index, "for_each", "in"],
      );
      continue;
    }

    if (
      source.kind === "static-object" &&
      !validateObjectFields(
        ctx,
        [...path, index, "for_each", "in"],
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
        if (source.kind === "static-step-list") {
          const placeholder = expandStepPlaceholder(
            rawBody,
            varName,
            source.values[binding.index] ?? {},
          );
          if (placeholder.length > 0) return placeholder;
        }
        const body = structuredClone(rawBody);
        applyCompileSubstitution(ctx, body, [...path, index, "steps"]);
        const bodySteps = asArray(body).filter(isStepRecord) as Step[];
        return expandLoopInSteps(
          ctx,
          jobId,
          bodySteps,
          [...path, index, "steps"],
          [...scopeVars, varName],
        );
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
        `for_each "in" is empty; the loop expands to nothing`,
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
          `for_each generates duplicate job id "${siblingId}"`,
        ),
        path,
      );
      return undefined;
    }
    seenIds.add(siblingId);

    const sibling = cloneNode(ctx, job);
    delete sibling.for_each;
    sibling.needs = previousId ? [previousId] : originalNeeds;

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
    previousId = siblingId;
  }

  const shareProducers = collectShareProducers(job.steps ?? []);
  recordShareContract(ctx, jobId, "serial-jobs", bindings, shareProducers, false);
  maybeWarnSerialOnlyKnob(ctx, config, path);
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
  delete job.for_each;
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
          matrixSymbol(`for_each.${loopVar}`, `\${{ matrix.${asName} }}`),
          matrixSymbol("index", `\${{ matrix.${asName} }}`),
          matrixSymbol("key", `\${{ matrix.${asName} }}`),
        ]
      : [
          matrixSymbol(loopVar, matrixSymbolObjectFromInclude(source.values)),
          matrixSymbol(`for_each.${loopVar}`, matrixSymbolObjectFromInclude(source.values)),
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
        "share: inside a runtime-list for_each can't emit per-iteration outputs (matrix outputs are last-leg-wins); make the list static or await v2 artifact fan-in",
      ),
      path,
    );
    return;
  }

  delete job.for_each;
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
  job.dynamic_matrix = dynamicBlock;

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
  const config = normalizedConfig(job.for_each);
  if (!config) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage("for-each-shape", "for_each must be a mapping"),
      ["jobs", jobId, "for_each"],
    );
    return { [jobId]: job };
  }
  if (!checkRequiredConfig(ctx, ["jobs", jobId, "for_each"], config)) return { [jobId]: job };
  const loopVar = String(config.var).trim();
  const source = resolveLoopSource(ctx, config.in, ["jobs", jobId, "for_each", "in"]);
  if (!source) return { [jobId]: job };

  if (job.dynamic_matrix != null) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-dynamic-matrix-collision",
        "job already defines a matrix; remove dynamic_matrix or for_each",
      ),
      ["jobs", jobId, "for_each"],
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
        ["jobs", jobId, "for_each", "in"],
      );
      return { [jobId]: job };
    }
    return buildSerialSiblingJobs(ctx, jobId, job, config, source, loopVar, [
      "jobs",
      jobId,
      "for_each",
    ]);
  }

  if (source.kind === "runtime-expr" || source.kind === "generator") {
    applyDynamicDelegation(ctx, jobId, job, config, source, loopVar, ["jobs", jobId, "for_each"]);
    return { [jobId]: job };
  }

  if (source.kind === "static-step-list") {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-job-step-list",
        `for_each "in" must be a scalar/object list at job scope`,
      ),
      ["jobs", jobId, "for_each", "in"],
    );
    return { [jobId]: job };
  }

  if (source.kind === "static-scalar" && source.values.length === 0) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-empty-parallel",
        `for_each "in" is empty; parallel literal loops would emit an invalid empty matrix`,
      ),
      ["jobs", jobId, "for_each", "in"],
    );
    delete job.for_each;
    return { [jobId]: job };
  }

  if (
    source.kind === "static-object" &&
    !validateObjectFields(ctx, ["jobs", jobId, "for_each", "in"], loopVar, job, source.values)
  ) {
    return { [jobId]: job };
  }

  applyParallelMatrixLoop(ctx, jobId, job, config, source, loopVar);
  return { [jobId]: job };
};

const STATE_ENV_RE = /\bGITHUB_(ENV|PATH)\b/;

/**
 * A step "establishes shared state" when its effects (a populated workspace, a
 * mutated `$GITHUB_ENV`/`$GITHUB_PATH`) are observed by *later* in-job steps.
 * Hoisting a downstream loop onto a fresh matrix runner silently drops that
 * state, so we refuse the rewrite when such a step sits before the loop.
 */
const isStateEstablishingStep = (step: unknown): boolean => {
  if (!isObject(step)) return false;
  const uses = step.uses;
  if (typeof uses === "string" && /^actions\/checkout(@|$)/.test(uses.trim())) return true;
  const run = step.run;
  if (typeof run === "string" && STATE_ENV_RE.test(run)) return true;
  return false;
};

const isRuntimeStepLoop = (step: unknown): boolean => {
  if (!isObject(step) || !Object.hasOwn(step, "for_each")) return false;
  const config = normalizedConfig(step.for_each);
  return !!config && typeof config.in === "string" && isRuntimeExpr(config.in);
};

/**
 * Build the matrixed loop job from a runtime-list step loop: replicate the
 * job's execution context (runs-on/env/container/services/defaults via clone),
 * emit `strategy.matrix.<as>: ${{ fromJSON(...) }}`, bind the loop var to
 * `${{ matrix.<as> }}`, and expand the loop body in place.
 */
const buildRuntimeLoopJob = (
  ctx: ParseContext,
  loopJobId: string,
  job: Job,
  config: LoopConfig,
  source: LoopSourceRuntimeExpr,
  loopVar: string,
  body: unknown[],
  needs: string[],
): Job => {
  const loopJob = cloneNode(ctx, job);
  delete loopJob.for_each;
  loopJob.steps = structuredClone(body) as Step[];
  if (needs.length > 0) loopJob.needs = needs;
  else delete loopJob.needs;

  const asName = normalizeAs(config.as, loopVar);
  const strategy = isObject(loopJob.strategy) ? { ...loopJob.strategy } : {};
  const matrix = isObject(strategy.matrix) ? { ...strategy.matrix } : {};
  matrix[asName] = source.expression;
  strategy.matrix = matrix;
  setMatrixFailFastAndMaxParallel(strategy, config);
  loopJob.strategy = strategy;

  const symbols = [
    matrixSymbol(loopVar, `\${{ matrix.${asName} }}`),
    matrixSymbol(`for_each.${loopVar}`, `\${{ matrix.${asName} }}`),
    matrixSymbol("index", `\${{ matrix.${asName} }}`),
    matrixSymbol("key", `\${{ matrix.${asName} }}`),
  ];
  withScopedSymbols(ctx, symbols, () => {
    applyCompileSubstitution(ctx, loopJob, ["jobs", loopJobId]);
    if (Array.isArray(loopJob.steps)) {
      loopJob.steps = expandLoopInSteps(
        ctx,
        loopJobId,
        loopJob.steps,
        ["jobs", loopJobId, "steps"],
        [loopVar],
      );
    }
  });
  recordShareContract(ctx, loopJobId, "parallel-matrix", [], [], true);
  return loopJob;
};

/**
 * Auto-rewrite the cleanly-hoistable shape of a step-level for_each over a
 * runtime `${{ }}` list into a native matrix job. Returns the replacement job
 * map on success, a single-job fail-loud map when the shape is unsafe, or
 * `undefined` to fall through to the generic serial-step path.
 *
 * Acceptance bar: correct native matrix OR fail loud — never silently wrong.
 */
const tryHoistRuntimeStepLoop = (
  ctx: ParseContext,
  jobId: string,
  job: Job,
): Record<string, Job> | undefined => {
  const steps = job.steps;
  if (!Array.isArray(steps)) return undefined;

  const runtimeIdxs: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (isRuntimeStepLoop(steps[i])) runtimeIdxs.push(i);
  }
  if (runtimeIdxs.length === 0) return undefined;

  const stepsPath: Path = ["jobs", jobId, "steps"];

  if (runtimeIdxs.length > 1) {
    const secondIdx = runtimeIdxs[1] ?? 0;
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-step-runtime",
        "a job with more than one runtime-list for_each step loop can't be hoisted into a single matrix; split them across jobs or make the lists compile-time",
      ),
      [...stepsPath, secondIdx, "for_each", "in"],
    );
    return { [jobId]: job };
  }

  const loopIdx = runtimeIdxs[0];
  if (loopIdx === undefined) return undefined;
  const loopStep = steps[loopIdx] as Step;
  const loopPath: Path = [...stepsPath, loopIdx, "for_each"];
  const config = normalizedConfig(loopStep.for_each);
  if (!config || !checkRequiredConfig(ctx, loopPath, config)) return { [jobId]: job };
  const loopVar = String(config.var).trim();

  if (!normalizeParallel(config.parallel)) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-step-runtime",
        "a serial (parallel: false) for_each over a runtime list needs a compile-time list; a runtime list can only fan out as a matrix",
      ),
      [...loopPath, "parallel"],
    );
    return { [jobId]: job };
  }

  const source = resolveLoopSource(ctx, config.in, [...loopPath, "in"]);
  if (!source) return { [jobId]: job };
  if (source.kind !== "runtime-expr") return undefined;

  const body = collectBodySteps(loopStep);
  if (collectShareProducers(body).length > 0) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "E-share-in-dynamic-loop",
        "share: inside a runtime-list for_each can't emit per-iteration outputs (matrix outputs are last-leg-wins); make the list static or await v2 artifact fan-in",
      ),
      [...stepsPath, loopIdx, "steps"],
    );
    return { [jobId]: job };
  }

  const preSteps = steps.slice(0, loopIdx);
  const postSteps = steps.slice(loopIdx + 1);

  if (postSteps.length > 0) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-step-runtime",
        "steps after a runtime-list for_each can't observe per-iteration matrix state once the loop is hoisted into its own job; move them into the loop body or make the list compile-time",
      ),
      [...stepsPath, loopIdx + 1],
    );
    return { [jobId]: job };
  }

  const coupledPre = preSteps.findIndex(isStateEstablishingStep);
  if (coupledPre >= 0) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "for-each-step-runtime",
        "a runtime-list for_each can't be hoisted past a step that establishes shared state (checkout, $GITHUB_ENV/$GITHUB_PATH); the matrix legs run on fresh runners. Make the list compile-time or fold the setup into the loop body",
      ),
      [...stepsPath, coupledPre],
    );
    return { [jobId]: job };
  }

  const originalNeeds = normalizeNeedsArray(job.needs);

  if (preSteps.length === 0) {
    return {
      [jobId]: buildRuntimeLoopJob(ctx, jobId, job, config, source, loopVar, body, originalNeeds),
    };
  }

  const preJobId = `${jobId}-pre`;
  const preJob = cloneNode(ctx, job);
  delete preJob.for_each;
  delete preJob.strategy;
  delete preJob.outputs;
  preJob.steps = expandLoopInSteps(
    ctx,
    preJobId,
    structuredClone(preSteps) as Step[],
    ["jobs", preJobId, "steps"],
    [],
  );
  if (originalNeeds.length > 0) preJob.needs = originalNeeds;
  else delete preJob.needs;

  const loopJob = buildRuntimeLoopJob(ctx, jobId, job, config, source, loopVar, body, [
    preJobId,
    ...originalNeeds,
  ]);

  return { [preJobId]: preJob, [jobId]: loopJob };
};

const processStepLoopsForJob = (
  ctx: ParseContext,
  jobId: string,
  job: Job,
): Record<string, Job> => {
  if (!Array.isArray(job.steps)) return { [jobId]: job };
  const hoisted = tryHoistRuntimeStepLoop(ctx, jobId, job);
  if (hoisted) return hoisted;
  job.steps = expandLoopInSteps(ctx, jobId, job.steps, ["jobs", jobId, "steps"], []);
  return { [jobId]: job };
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
    const transformed = Object.hasOwn(job, "for_each")
      ? processJobLoop(ctx, jobId, job)
      : { [jobId]: job };
    if (!transformed) continue;

    for (const [nextId, nextJobRaw] of Object.entries(transformed)) {
      if (!isObject(nextJobRaw)) continue;
      const expanded = processStepLoopsForJob(ctx, nextId, nextJobRaw as Job);
      for (const [outId, outJob] of Object.entries(expanded)) {
        rebuilt[outId] = outJob;
        rebuiltOrder.push(outId);
      }
    }
  }

  setKeyOrder(rebuilt, rebuiltOrder);
  ctx.data.jobs = rebuilt;
};

// TODO(share-foreach-integration): #18 consumes ctx.internal.forEachShareContracts in the joint seam.
export const forEach: Pass = {
  name: "for_each",
  runsAfter: ["params", "job_defaults"],
  apply: forEachPass,
};

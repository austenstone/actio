import type { ParamType, SymbolDef, SymbolKind } from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import { conservativeTaint, RUNTIME_CONTEXT_ROOT_SET } from "../symbols.js";
import { collectRefNodes, type EvalEnv, ExprError, evalExpr, parseExpression } from "./expr.js";
import { expectMapping, isObject, pushDiagnostic, warnUnknownKeys } from "./helpers.js";
import type { Pass } from "./registry.js";

export const PARAM_TYPES: ReadonlySet<ParamType> = new Set([
  "string",
  "number",
  "boolean",
  "enum",
  "object",
  "stepList",
  "steps",
]);

const PARAM_DEFINITION_BASE_KEYS = new Set(["type", "default"]);
const PARAM_DEFINITION_ENUM_KEYS = new Set([...PARAM_DEFINITION_BASE_KEYS, "values"]);

const symbolKindForType = (type: ParamType): SymbolKind => {
  if (type === "stepList" || type === "steps") return "param-stepList";
  if (type === "object") return "param-list";
  return "param-scalar";
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStepList = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.every((entry) => isObject(entry));

const typeAcceptsDefault = (type: ParamType, value: unknown): boolean => {
  if (value === undefined) return true;
  if (type === "string") return typeof value === "string";
  if (type === "number") return isFiniteNumber(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "enum") return typeof value === "string";
  if (type === "object") return (isObject(value) || Array.isArray(value)) && value !== null;
  return isStepList(value);
};

/** A provided (non-undefined) value satisfies a declared param type. */
export const valueMatchesParamType = (type: ParamType, value: unknown): boolean =>
  value !== undefined && typeAcceptsDefault(type, value);

export const validateEnumValues = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!raw.every((value) => typeof value === "string")) return undefined;
  return [...raw];
};

const collectParamSymbol = (
  ctx: ParseContext,
  name: string,
  rawDefinition: unknown,
  path: Path,
): SymbolDef | undefined => {
  if (
    !expectMapping(ctx, rawDefinition, path, {
      message: `params.${name} must be an object definition`,
      code: "param-definition-invalid",
    })
  ) {
    return undefined;
  }

  const typeRaw = rawDefinition.type;
  const allowedKeys =
    typeof typeRaw === "string" && typeRaw === "enum"
      ? PARAM_DEFINITION_ENUM_KEYS
      : PARAM_DEFINITION_BASE_KEYS;

  const unknownKeys = warnUnknownKeys(ctx, rawDefinition, allowedKeys, path, {
    severity: "error",
    message: (key) => `params.${name}.${key} is not a supported parameter definition field`,
    code: "param-definition-key-unknown",
  });
  if (unknownKeys.length > 0) {
    return undefined;
  }

  if (typeof typeRaw !== "string" || !PARAM_TYPES.has(typeRaw as ParamType)) {
    pushDiagnostic(
      ctx,
      "error",
      `params.${name}.type must be one of ${[...PARAM_TYPES].join(", ")}`,
      [...path, "type"],
      { code: "param-type-invalid" },
    );
    return undefined;
  }

  const type = typeRaw as ParamType;
  const values = validateEnumValues(rawDefinition.values);
  if (type === "enum" && !values) {
    pushDiagnostic(
      ctx,
      "error",
      `params.${name}.values must be a non-empty string array when type is enum`,
      [...path, "values"],
      { code: "param-enum-values" },
    );
    return undefined;
  }

  const hasDefault = Object.hasOwn(rawDefinition, "default");
  const defaultValue = rawDefinition.default;
  if (!typeAcceptsDefault(type, defaultValue)) {
    pushDiagnostic(
      ctx,
      "error",
      `params.${name}.default does not match declared type "${type}"`,
      [...path, "default"],
      { code: "param-default-type" },
    );
    return undefined;
  }

  if (
    type === "enum" &&
    defaultValue !== undefined &&
    values &&
    !values.includes(defaultValue as string)
  ) {
    pushDiagnostic(
      ctx,
      "error",
      `params.${name}.default must be one of [${values.join(", ")}]`,
      [...path, "default"],
      { code: "param-enum-default" },
    );
    return undefined;
  }

  const compileTimeKnown = hasDefault;
  const valueKnown = hasDefault;
  const symbolName = `params.${name}`;
  return {
    name: symbolName,
    kind: symbolKindForType(type),
    type,
    compileTimeKnown,
    hasDefault,
    valueKnown,
    required: !hasDefault,
    taint: conservativeTaint(),
    value: hasDefault ? defaultValue : undefined,
  };
};

const lookupSymbolValue = (
  ctx: ParseContext,
  segments: string[],
): { symbol?: SymbolDef; value?: unknown; resolved: boolean } => {
  const root = segments[0];
  if (!root) return { resolved: false };

  let symbolKey: string | undefined;
  let offset = 0;
  if (segments.length >= 2) {
    const candidate = `${root}.${segments[1]}`;
    if (ctx.symbols.has(candidate)) {
      symbolKey = candidate;
      offset = 2;
    }
  }
  if (!symbolKey && ctx.symbols.has(root)) {
    symbolKey = root;
    offset = 1;
  }
  if (!symbolKey) return { resolved: false };

  const symbol = ctx.symbols.get(symbolKey);
  if (!symbol) return { resolved: false };
  const valueKnown = symbol.valueKnown ?? symbol.compileTimeKnown;
  if (!valueKnown) return { symbol, resolved: false };

  let current = symbol.value;
  for (const segment of segments.slice(offset)) {
    if (isObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
      continue;
    }
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      const index = Number(segment);
      if (index < current.length) {
        current = current[index];
        continue;
      }
    }
    return { symbol, resolved: false };
  }
  return { symbol, value: current, resolved: current !== undefined };
};

const EMPTY_SCOPE: ReadonlyMap<string, unknown> = new Map();

const compileEvalEnv = (ctx: ParseContext): EvalEnv => ({
  resolveRef: (segments) => {
    const looked = lookupSymbolValue(
      ctx,
      segments.map((segment) => String(segment)),
    );
    return looked.resolved ? { resolved: true, value: looked.value } : { resolved: false };
  },
  scope: EMPTY_SCOPE,
});

export interface CompileTimeExpressionResolution {
  symbol?: SymbolDef;
  value?: unknown;
  resolved: boolean;
}

export const resolveCompileTimeExpressionValue = (
  ctx: ParseContext,
  expression: string,
): CompileTimeExpressionResolution => {
  const parsed = parseExpression(expression.trim());
  if (!parsed) return { resolved: false };
  const node =
    parsed.kind === "call" && parsed.name === "toJSON" && parsed.args.length === 1
      ? parsed.args[0]
      : parsed;
  if (node && node.kind === "ref") {
    return lookupSymbolValue(
      ctx,
      node.segments.map((segment) => String(segment)),
    );
  }
  try {
    const value = evalExpr(parsed, compileEvalEnv(ctx));
    return { resolved: value !== undefined, value };
  } catch {
    return { resolved: false };
  }
};

const isIdentifierStart = (char: string): boolean => /[A-Za-z_]/.test(char);

const isIdentifierPart = (char: string): boolean => /[A-Za-z0-9_]/.test(char);

/**
 * Scan a text boundary for runtime `${{ ... }}` expressions whose body references
 * the `params` root context. Params are compile-time only, so a `params` root
 * inside a runtime sigil is a hard error.
 *
 * This is a single quote-aware tokenizer. For each `${{`, it walks to the REAL
 * top-level closing `}}`, skipping `}}` that appear inside single- or
 * double-quoted GHA string literals (honoring `''` and `\"` escaping), and scans
 * the body for a `params` root in the same pass. Locating the close with a naive
 * `indexOf("}}")` is unsound: a `}}` inside a literal — e.g. `format('}}',
 * params.env)` — truncates the body before the `params` root and silently bypasses
 * the guard, so the contract must not depend on a separate, non-quote-aware close
 * finder. Dotted access (`steps.params.outputs.x`) and substrings (`vars.myparams`)
 * are correctly ignored.
 *
 * Returns the trimmed body of every offending expression (one diagnostic each).
 */
const findParamsRootRuntimeExpressions = (value: string): string[] => {
  const offending: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("${{", cursor);
    if (open < 0) break;

    const bodyStart = open + 3;
    let index = bodyStart;
    let quote: "'" | '"' | undefined;
    let hasParamsRoot = false;
    let close = -1;

    while (index < value.length) {
      const char = value[index];
      if (!char) {
        index++;
        continue;
      }

      if (quote) {
        if (char === quote) {
          if (quote === "'" && value[index + 1] === "'") {
            index += 2;
            continue;
          }
          if (quote === '"') {
            let bs = 0;
            let j = index - 1;
            while (j >= bodyStart && value[j] === "\\") {
              bs++;
              j--;
            }
            if (bs % 2 === 1) {
              index++;
              continue;
            }
          }
          quote = undefined;
        }
        index++;
        continue;
      }

      if (char === "'" || char === '"') {
        quote = char;
        index++;
        continue;
      }

      if (char === "}" && value[index + 1] === "}") {
        close = index;
        break;
      }

      if (isIdentifierStart(char)) {
        const idStart = index;
        let end = index + 1;
        while (end < value.length && isIdentifierPart(value[end] ?? "")) end++;
        index = end;
        if (value.slice(idStart, end) === "params") {
          let prev = idStart - 1;
          while (prev >= bodyStart && /\s/.test(value[prev] ?? "")) prev--;
          if (!(prev >= bodyStart && value[prev] === ".")) {
            hasParamsRoot = true;
          }
        }
        continue;
      }

      index++;
    }

    if (close < 0) break;
    if (hasParamsRoot) offending.push(value.slice(bodyStart, close).trim());
    cursor = close + 2;
  }
  return offending;
};

const hasCompileToken = (value: string): boolean => {
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("{{", cursor);
    if (open < 0) return false;
    if (open === 0 || value[open - 1] !== "$") return true;
    cursor = open + 2;
  }
  return false;
};

export interface ResolveTextOptions {
  validateRuntimeExpressions?: boolean;
  enforceNoResidualTokens?: boolean;
  reportInterpolationErrors?: boolean;
  /**
   * Marks the final pipeline boundary walk: expand matrix comprehensions to a
   * native `strategy.matrix.include` and lint for stray compile tokens. Set only
   * by `runCompletePassPipeline` so intermediate passes (fragments/forEach) never
   * trip the guardrail before symbols are fully bound.
   */
  guardrail?: boolean;
}

const mapInterpolationError = (
  error: unknown,
  token: string,
): { code: string; message: string } => {
  if (error instanceof ExprError) {
    if (error.code === "type") return { code: "expr-type-error", message: error.message };
    if (error.code === "runtime-fn") return { code: "expr-runtime-fn", message: error.message };
  }
  return {
    code: "interp-unresolved",
    message: `Cannot resolve compile-time expression "${token}" from the symbol table`,
  };
};

const interpolateCompileTokens = (
  ctx: ParseContext,
  value: string,
  path: Path,
  options: ResolveTextOptions,
): string => {
  let cursor = 0;
  let output = "";

  while (cursor < value.length) {
    const open = value.indexOf("{{", cursor);
    if (open < 0) {
      output += value.slice(cursor);
      break;
    }

    if (open > 0 && value[open - 1] === "$") {
      output += value.slice(cursor, open + 2);
      cursor = open + 2;
      continue;
    }

    output += value.slice(cursor, open);
    const close = value.indexOf("}}", open + 2);
    if (close < 0) {
      if (options.reportInterpolationErrors !== false) {
        pushDiagnostic(ctx, "error", `Unclosed compile-time interpolation in "${value}"`, path, {
          code: "interp-unresolved",
        });
      }
      output += value.slice(open);
      break;
    }

    const token = value.slice(open + 2, close).trim();
    const report = options.reportInterpolationErrors !== false;
    const parsed = parseExpression(token);
    if (!parsed) {
      if (report) {
        pushDiagnostic(ctx, "error", `Cannot parse compile-time expression "${token}"`, path, {
          code: "interp-unresolved",
        });
      }
      output += value.slice(open, close + 2);
      cursor = close + 2;
      continue;
    }

    let resolvedValue: unknown;
    try {
      resolvedValue = evalExpr(parsed, compileEvalEnv(ctx));
    } catch (error) {
      if (report) {
        const mapped = mapInterpolationError(error, token);
        pushDiagnostic(ctx, "error", mapped.message, path, { code: mapped.code });
      }
      output += value.slice(open, close + 2);
      cursor = close + 2;
      continue;
    }

    if (resolvedValue === undefined) {
      if (report) {
        pushDiagnostic(ctx, "error", `Cannot serialize compile-time expression "${token}"`, path, {
          code: "interp-unresolved",
        });
      }
      output += value.slice(open, close + 2);
      cursor = close + 2;
      continue;
    }

    if ((isObject(resolvedValue) || Array.isArray(resolvedValue)) && resolvedValue !== null) {
      if (report) {
        pushDiagnostic(
          ctx,
          "error",
          `Expression "${token}" resolved to a non-scalar value; wrap it as {{ toJSON(...) }}`,
          path,
          { code: "interp-non-scalar" },
        );
      }
      output += value.slice(open, close + 2);
      cursor = close + 2;
      continue;
    }

    output += String(resolvedValue);
    cursor = close + 2;
  }

  return output;
};

/** Resolve compile-time interpolation in a text boundary and enforce runtime params sigil rules. */
export const resolveCompileTimeText = (
  ctx: ParseContext,
  value: string,
  path: Path,
  options: ResolveTextOptions = {},
): string => {
  if (options.validateRuntimeExpressions !== false) {
    for (const expr of findParamsRootRuntimeExpressions(value)) {
      pushDiagnostic(
        ctx,
        "error",
        `Runtime expression "\${{ ${expr} }}" is invalid for params; use "{{ params.* }}"`,
        path,
        { code: "params-runtime-sigil" },
      );
    }
  }

  const interpolated = interpolateCompileTokens(ctx, value, path, options);
  if (options.enforceNoResidualTokens !== false && hasCompileToken(interpolated)) {
    pushDiagnostic(
      ctx,
      "error",
      `Compile-time interpolation was left unresolved in "${interpolated}"`,
      path,
      { code: "interp-unresolved" },
    );
  }
  return interpolated;
};

/** Resolve compile-time text interpolation recursively in a value tree. */
/** True when `path` ends at a job's `strategy.matrix` definition. */
const isMatrixDefPosition = (path: Path): boolean =>
  path.length >= 2 && path[path.length - 1] === "matrix" && path[path.length - 2] === "strategy";

/**
 * A whole-value matrix comprehension `{{ [expr for x in list] }}` evaluates at
 * build time to a native `strategy.matrix.include` array. Returns the rewritten
 * matrix object, or undefined when `value` is not a comprehension (fall through
 * to normal text resolution, preserving the bare-ref `interp-non-scalar` path).
 */
const expandMatrixComprehension = (
  ctx: ParseContext,
  value: string,
  path: Path,
): { include: unknown[] } | undefined => {
  const inner = wholeValueToken(value);
  if (inner === undefined) return undefined;
  const node = parseExpression(inner);
  if (node?.kind !== "comprehension") return undefined;
  try {
    const result = evalExpr(node, compileEvalEnv(ctx));
    if (!Array.isArray(result)) {
      pushDiagnostic(
        ctx,
        "error",
        `Matrix comprehension "${inner}" must evaluate to a list`,
        path,
        {
          code: "expr-type-error",
        },
      );
      return { include: [] };
    }
    return { include: result };
  } catch (error) {
    const mapped = mapInterpolationError(error, inner);
    pushDiagnostic(ctx, "error", mapped.message, path, { code: mapped.code });
    return { include: [] };
  }
};

/** Report a compile-time `{{ }}` token that survived into an emitted position. */
const reportStrayCompileToken = (ctx: ParseContext, value: string, path: Path): void => {
  const usesPosition = path.length > 0 && path[path.length - 1] === "uses";
  pushDiagnostic(
    ctx,
    "error",
    usesPosition
      ? `Unresolved compile-time token survived into a uses: position: "${value}"`
      : `Stray compile-time token in a non-evaluated position: "${value}"`,
    path,
    { code: usesPosition ? "uses-unresolved" : "expr-stray" },
  );
};

export const resolveCompileTimeTextBoundaries = (
  ctx: ParseContext,
  value: unknown,
  path: Path,
  options: ResolveTextOptions = {},
): unknown => {
  if (typeof value === "string") {
    if (options.guardrail && isMatrixDefPosition(path)) {
      const matrix = expandMatrixComprehension(ctx, value, path);
      if (matrix !== undefined) return matrix;
    }
    const resolved = resolveCompileTimeText(ctx, value, path, options);
    if (options.guardrail && typeof resolved === "string" && hasCompileToken(resolved)) {
      reportStrayCompileToken(ctx, resolved, path);
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      value[index] = resolveCompileTimeTextBoundaries(ctx, value[index], [...path, index], options);
    }
    return value;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      value[key] = resolveCompileTimeTextBoundaries(ctx, child, [...path, key], options);
    }
  }
  return value;
};

/** A call-site template argument: its declared type plus the bound value. */
export interface TemplateArg {
  type: ParamType;
  value: unknown;
}

const makeBoundSymbol = (name: string, type: ParamType, value: unknown): SymbolDef => ({
  name,
  kind: symbolKindForType(type),
  type,
  compileTimeKnown: true,
  hasDefault: true,
  valueKnown: true,
  required: false,
  taint: conservativeTaint(),
  value,
});

/**
 * Resolve `{{ args.* }}` inside a cloned template body by binding the call-site
 * args as temporary `args.<name>` symbols on the SAME shared symbol table the
 * params text path already reads, then running the one compile-time resolver.
 * Routing args through this seam (rather than a bespoke substituter) is what
 * keeps a single evaluator: PR3 upgrades the engine behind it and this callsite
 * never changes. Bindings are restored afterward so sibling and nested injects
 * never observe another inject's args.
 */
export const resolveArgsInBody = (
  ctx: ParseContext,
  body: unknown,
  args: Record<string, TemplateArg>,
  path: Path,
): unknown => {
  const saved = new Map<string, SymbolDef | undefined>();
  for (const [name, arg] of Object.entries(args)) {
    const key = `args.${name}`;
    saved.set(key, ctx.symbols.get(key));
    ctx.symbols.set(key, makeBoundSymbol(key, arg.type, arg.value));
  }
  try {
    return resolveCompileTimeTextBoundaries(ctx, body, path, {
      validateRuntimeExpressions: false,
      enforceNoResidualTokens: false,
      reportInterpolationErrors: false,
    });
  } finally {
    for (const [key, prev] of saved) {
      if (prev === undefined) ctx.symbols.delete(key);
      else ctx.symbols.set(key, prev);
    }
  }
};

const isStepListPosition = (path: Path): boolean => path[path.length - 1] === "steps";

const resolveBareStructuralExpression = (ctx: ParseContext, value: string, path: Path): unknown => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  if (trimmed.includes("{{") || trimmed.includes("}}")) return value;

  const parsed = parseExpression(trimmed);
  if (parsed?.kind !== "ref") return value;

  const lookedUp = lookupSymbolValue(
    ctx,
    parsed.segments.map((segment) => String(segment)),
  );
  if (!lookedUp.symbol) return value;
  if (!lookedUp.resolved) {
    pushDiagnostic(
      ctx,
      "error",
      `Cannot resolve structural expression "${trimmed}" from the symbol table`,
      path,
      { code: "param-structural-unresolved" },
    );
    return value;
  }

  if (isStepListPosition(path) && !isStepList(lookedUp.value)) {
    pushDiagnostic(
      ctx,
      "error",
      `Expression "${trimmed}" must resolve to a step list in this position`,
      path,
      { code: "param-structural-type" },
    );
    return value;
  }

  return structuredClone(lookedUp.value);
};

const resolveStructuralExpressionsInTree = (
  ctx: ParseContext,
  value: unknown,
  path: Path,
): unknown => {
  if (typeof value === "string") return resolveBareStructuralExpression(ctx, value, path);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      value[index] = resolveStructuralExpressionsInTree(ctx, value[index], [...path, index]);
    }
    return value;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "static-if") continue;
      value[key] = resolveStructuralExpressionsInTree(ctx, child, [...path, key]);
    }
  }
  return value;
};

/** Infer the closest param type for a resolved compile-time value. */
const paramTypeOfValue = (value: unknown): ParamType => {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return isStepList(value) ? "steps" : "object";
  if (isObject(value)) return "object";
  return "string";
};

/** Extract every compile-time `{{ ... }}` token body from a text value. */
const compileTokensOf = (value: string): string[] => {
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("{{", cursor);
    if (open < 0) break;
    if (open > 0 && value[open - 1] === "$") {
      cursor = open + 2;
      continue;
    }
    const close = value.indexOf("}}", open + 2);
    if (close < 0) break;
    tokens.push(value.slice(open + 2, close).trim());
    cursor = close + 2;
  }
  return tokens;
};

/** Return the inner expression when a value is exactly one whole-value `{{ ... }}`. */
const wholeValueToken = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed.length < 4 || !trimmed.startsWith("{{") || !trimmed.endsWith("}}")) return undefined;
  const inner = trimmed.slice(2, -2);
  if (inner.includes("{{") || inner.includes("}}")) return undefined;
  return inner.trim();
};

/** `let` names this value depends on, for topological ordering within the pass. */
const letDependencies = (raw: string, letNames: ReadonlySet<string>): string[] => {
  const deps = new Set<string>();
  for (const token of compileTokensOf(raw)) {
    const node = parseExpression(token);
    if (!node) continue;
    for (const ref of collectRefNodes(node)) {
      const [head, second] = ref.segments;
      if (head === "let" && typeof second === "string" && letNames.has(second)) deps.add(second);
    }
  }
  return [...deps];
};

const mapLetEvalError = (error: unknown, expr: string): { code: string; message: string } => {
  if (error instanceof ExprError) {
    if (error.code === "parse") return { code: "expr-parse-error", message: error.message };
    if (error.code === "type") return { code: "expr-type-error", message: error.message };
    if (error.code === "runtime-fn") return { code: "expr-runtime-fn", message: error.message };
    return { code: "expr-unknown-name", message: error.message };
  }
  return { code: "expr-unknown-name", message: `Cannot resolve compile-time expression "${expr}"` };
};

/** Resolve one `let` value to a typed compile-time constant, or undefined on error. */
const resolveLetValue = (
  ctx: ParseContext,
  name: string,
  raw: unknown,
): { type: ParamType; value: unknown } | undefined => {
  const path: Path = ["let", name];
  if (typeof raw !== "string") return { type: paramTypeOfValue(raw), value: raw };

  if (raw.includes("${{")) {
    pushDiagnostic(
      ctx,
      "error",
      `let.${name} must be compile-time; "\${{ }}" is a runtime expression`,
      path,
      { code: "let-not-compile-time" },
    );
    return undefined;
  }

  for (const token of compileTokensOf(raw)) {
    const node = parseExpression(token);
    if (!node) continue;
    for (const ref of collectRefNodes(node)) {
      const head = ref.segments[0];
      if (typeof head === "string" && RUNTIME_CONTEXT_ROOT_SET.has(head)) {
        pushDiagnostic(
          ctx,
          "error",
          `let.${name} must be compile-time; "${head}" is a runtime context`,
          path,
          { code: "let-not-compile-time" },
        );
        return undefined;
      }
    }
  }

  if (!hasCompileToken(raw)) return { type: "string", value: raw };

  const whole = wholeValueToken(raw);
  if (whole !== undefined) {
    const node = parseExpression(whole);
    if (!node) {
      pushDiagnostic(ctx, "error", `Cannot parse compile-time expression "${whole}"`, path, {
        code: "expr-parse-error",
      });
      return undefined;
    }
    try {
      const value = evalExpr(node, compileEvalEnv(ctx));
      if (value === undefined) {
        pushDiagnostic(
          ctx,
          "error",
          `Cannot resolve compile-time expression "${whole}" from the symbol table`,
          path,
          { code: "expr-unknown-name" },
        );
        return undefined;
      }
      return { type: paramTypeOfValue(value), value };
    } catch (error) {
      const mapped = mapLetEvalError(error, whole);
      pushDiagnostic(ctx, "error", mapped.message, path, { code: mapped.code });
      return undefined;
    }
  }

  const text = resolveCompileTimeText(ctx, raw, path, { validateRuntimeExpressions: false });
  return { type: "string", value: text };
};

/**
 * Bind top-level `let:` as file-local compile-time constants AFTER params bind.
 * Values may reference earlier `let`/`params`, so resolution is topologically
 * ordered over let -> let dependencies; a cycle is a compile-time error.
 */
const resolveLet = (ctx: ParseContext): void => {
  const rawLet = ctx.data.let;
  if (rawLet === undefined) return;
  if (
    !expectMapping(ctx, rawLet, ["let"], {
      message: "Top-level let must be a mapping",
      code: "let-shape-invalid",
    })
  ) {
    delete ctx.data.let;
    return;
  }

  const names = new Set(Object.keys(rawLet));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const name of names) {
    indegree.set(name, 0);
    dependents.set(name, []);
  }
  for (const [name, raw] of Object.entries(rawLet)) {
    const deps = typeof raw === "string" ? letDependencies(raw, names) : [];
    indegree.set(name, deps.length);
    for (const dep of deps) dependents.get(dep)?.push(name);
  }

  const ready = [...names].filter((name) => indegree.get(name) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const name = ready.shift();
    if (name === undefined) break;
    order.push(name);
    for (const dependent of dependents.get(name) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }

  const resolvedOrder = new Set(order);
  for (const name of names) {
    if (resolvedOrder.has(name)) continue;
    pushDiagnostic(
      ctx,
      "error",
      `let.${name} has a circular compile-time dependency`,
      ["let", name],
      { code: "let-not-compile-time" },
    );
  }

  for (const name of order) {
    if (ctx.symbols.has(`params.${name}`)) {
      pushDiagnostic(
        ctx,
        "error",
        `let.${name} redeclares a param of the same name`,
        ["let", name],
        {
          code: "let-redeclared",
        },
      );
      continue;
    }
    const resolved = resolveLetValue(ctx, name, (rawLet as Record<string, unknown>)[name]);
    if (resolved === undefined) continue;
    ctx.symbols.set(`let.${name}`, makeBoundSymbol(`let.${name}`, resolved.type, resolved.value));
  }

  delete ctx.data.let;
};

/** Collect top-level typed params into the symbol table and resolve bare structural expressions. */
export const paramsPass = (ctx: ParseContext): void => {
  const rawParams = ctx.data.params;
  const rawLet = ctx.data.let;
  if (rawParams === undefined && rawLet === undefined) return;

  let paramsInvalid = false;
  if (rawParams !== undefined) {
    if (
      expectMapping(ctx, rawParams, ["params"], {
        message: "Top-level params must be a mapping",
        code: "params-shape-invalid",
      })
    ) {
      for (const [name, rawDefinition] of Object.entries(rawParams)) {
        const symbol = collectParamSymbol(ctx, name, rawDefinition, ["params", name]);
        if (!symbol) continue;
        ctx.symbols.set(symbol.name, symbol);
      }
    } else {
      paramsInvalid = true;
    }
    delete ctx.data.params;
  }

  resolveLet(ctx);

  if (paramsInvalid && rawLet === undefined) return;
  resolveStructuralExpressionsInTree(ctx, ctx.data, []);
};

/** Tier-0 pass: seed typed params before any other transform executes. */
export const params: Pass = { name: "params", apply: paramsPass };

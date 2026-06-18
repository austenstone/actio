import type { ParamType, SymbolDef, SymbolKind } from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import { conservativeTaint } from "../symbols.js";
import { expectMapping, isObject, pushDiagnostic, warnUnknownKeys } from "./helpers.js";
import type { Pass } from "./registry.js";

interface ParsedExpr {
  segments: string[];
  asJson: boolean;
}

const PARAM_TYPES: ReadonlySet<ParamType> = new Set([
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

const validateEnumValues = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!raw.every((value) => typeof value === "string")) return undefined;
  return [...raw];
};

const parseCompileExpr = (raw: string): ParsedExpr | undefined => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  let asJson = false;
  let subject = trimmed;
  if (trimmed.startsWith("toJSON(") && trimmed.endsWith(")")) {
    asJson = true;
    subject = trimmed.slice("toJSON(".length, -1).trim();
    if (subject.length === 0) return undefined;
  }

  const segments = subject.split(".").map((segment) => segment.trim());
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) return undefined;
  if (
    segments.some((segment) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment) && !/^\d+$/.test(segment))
  ) {
    return undefined;
  }
  return { segments, asJson };
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
}

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
    const parsed = parseCompileExpr(token);
    if (!parsed) {
      if (options.reportInterpolationErrors !== false) {
        pushDiagnostic(ctx, "error", `Cannot parse compile-time expression "${token}"`, path, {
          code: "interp-unresolved",
        });
      }
      output += value.slice(open, close + 2);
      cursor = close + 2;
      continue;
    }

    const lookedUp = lookupSymbolValue(ctx, parsed.segments);
    if (!lookedUp.resolved) {
      if (options.reportInterpolationErrors !== false) {
        pushDiagnostic(
          ctx,
          "error",
          `Cannot resolve compile-time expression "${token}" from the symbol table`,
          path,
          { code: "interp-unresolved" },
        );
      }
      output += value.slice(open, close + 2);
      cursor = close + 2;
      continue;
    }

    const resolvedValue = lookedUp.value;
    if (parsed.asJson) {
      const json = JSON.stringify(resolvedValue);
      if (json === undefined) {
        if (options.reportInterpolationErrors !== false) {
          pushDiagnostic(
            ctx,
            "error",
            `Cannot serialize compile-time expression "${token}" with toJSON(...)`,
            path,
            { code: "interp-unresolved" },
          );
        }
        output += value.slice(open, close + 2);
        cursor = close + 2;
        continue;
      }
      output += json;
      cursor = close + 2;
      continue;
    }

    if ((isObject(resolvedValue) || Array.isArray(resolvedValue)) && resolvedValue !== null) {
      if (options.reportInterpolationErrors !== false) {
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
export const resolveCompileTimeTextBoundaries = (
  ctx: ParseContext,
  value: unknown,
  path: Path,
  options: ResolveTextOptions = {},
): unknown => {
  if (typeof value === "string") return resolveCompileTimeText(ctx, value, path, options);
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

const isStepListPosition = (path: Path): boolean => path[path.length - 1] === "steps";

const resolveBareStructuralExpression = (ctx: ParseContext, value: string, path: Path): unknown => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  if (trimmed.includes("{{") || trimmed.includes("}}")) return value;

  const parsed = parseCompileExpr(trimmed);
  if (!parsed || parsed.asJson) return value;

  const lookedUp = lookupSymbolValue(ctx, parsed.segments);
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
      if (key === "when_compile") continue;
      value[key] = resolveStructuralExpressionsInTree(ctx, child, [...path, key]);
    }
  }
  return value;
};

/** Collect top-level typed params into the symbol table and resolve bare structural expressions. */
export const paramsPass = (ctx: ParseContext): void => {
  const rawParams = ctx.data.params;
  if (rawParams === undefined) return;

  if (
    !expectMapping(ctx, rawParams, ["params"], {
      message: "Top-level params must be a mapping",
      code: "params-shape-invalid",
    })
  ) {
    delete ctx.data.params;
    return;
  }

  for (const [name, rawDefinition] of Object.entries(rawParams)) {
    const symbol = collectParamSymbol(ctx, name, rawDefinition, ["params", name]);
    if (!symbol) continue;
    ctx.symbols.set(symbol.name, symbol);
  }

  delete ctx.data.params;
  resolveStructuralExpressionsInTree(ctx, ctx.data, []);
};

/** Tier-0 pass: seed typed params before any other transform executes. */
export const params: Pass = { name: "params", apply: paramsPass };

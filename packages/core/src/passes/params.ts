import type { ParamType, SymbolDef, SymbolKind } from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import { conservativeTaint } from "../symbols.js";
import { isObject, pushDiagnostic } from "./helpers.js";
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

function diagnosticMessage(code: string, message: string): string {
  return `[${code}] ${message}`;
}

function symbolKindForType(type: ParamType): SymbolKind {
  if (type === "stepList" || type === "steps") return "param-stepList";
  if (type === "object") return "param-list";
  return "param-scalar";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStepList(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((entry) => isObject(entry));
}

function typeAcceptsDefault(type: ParamType, value: unknown, enumValues?: string[]): boolean {
  if (value === undefined) return true;
  if (type === "string") return typeof value === "string";
  if (type === "number") return isFiniteNumber(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "enum") return typeof value === "string" && Array.isArray(enumValues);
  if (type === "object") return (isObject(value) || Array.isArray(value)) && value !== null;
  return isStepList(value);
}

function validateEnumValues(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!raw.every((value) => typeof value === "string")) return undefined;
  return [...raw];
}

function collectParamSymbol(
  ctx: ParseContext,
  name: string,
  rawDefinition: unknown,
  path: Path,
): SymbolDef | undefined {
  if (!isObject(rawDefinition)) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage("param-definition-invalid", `params.${name} must be an object definition`),
      path,
    );
    return undefined;
  }

  const typeRaw = rawDefinition.type;
  if (typeof typeRaw !== "string" || !PARAM_TYPES.has(typeRaw as ParamType)) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "param-type-invalid",
        `params.${name}.type must be one of ${[...PARAM_TYPES].join(", ")}`,
      ),
      [...path, "type"],
    );
    return undefined;
  }

  const type = typeRaw as ParamType;
  const values = validateEnumValues(rawDefinition.values);
  if (type === "enum" && !values) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "param-enum-values",
        `params.${name}.values must be a non-empty string array when type is enum`,
      ),
      [...path, "values"],
    );
    return undefined;
  }

  const defaultValue = rawDefinition.default;
  if (!typeAcceptsDefault(type, defaultValue, values)) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "param-default-type",
        `params.${name}.default does not match declared type "${type}"`,
      ),
      [...path, "default"],
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
      diagnosticMessage(
        "param-enum-default",
        `params.${name}.default must be one of [${values.join(", ")}]`,
      ),
      [...path, "default"],
    );
    return undefined;
  }

  const symbolName = `params.${name}`;
  return {
    name: symbolName,
    kind: symbolKindForType(type),
    type,
    compileTimeKnown: true,
    taint: conservativeTaint(),
    value: defaultValue,
  };
}

function parseCompileExpr(raw: string): ParsedExpr | undefined {
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
}

function lookupSymbolValue(
  ctx: ParseContext,
  segments: string[],
): { symbol?: SymbolDef; value?: unknown; resolved: boolean } {
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
  if (!symbol?.compileTimeKnown) return { symbol, resolved: false };

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
}

function findRuntimeExpressions(value: string): string[] {
  const expressions: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("${{", cursor);
    if (open < 0) break;
    const close = value.indexOf("}}", open + 3);
    if (close < 0) break;
    expressions.push(value.slice(open + 3, close).trim());
    cursor = close + 2;
  }
  return expressions;
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function containsParamsRootReference(expr: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < expr.length; index++) {
    const char = expr[index];
    if (!char) continue;

    if (quote) {
      if (char !== quote) continue;
      if (quote === "'" && expr[index + 1] === "'") {
        index++;
        continue;
      }
      if (quote === '"' && expr[index - 1] === "\\") continue;
      quote = undefined;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (!isIdentifierStart(char)) continue;

    const start = index;
    let end = index + 1;
    while (end < expr.length && isIdentifierPart(expr[end] ?? "")) end++;
    const identifier = expr.slice(start, end);
    index = end - 1;

    if (identifier !== "params") continue;

    let prev = start - 1;
    while (prev >= 0 && /\s/.test(expr[prev] ?? "")) prev--;
    if (prev >= 0 && expr[prev] === ".") continue;
    return true;
  }
  return false;
}

function hasCompileToken(value: string): boolean {
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("{{", cursor);
    if (open < 0) return false;
    if (open === 0 || value[open - 1] !== "$") return true;
    cursor = open + 2;
  }
  return false;
}

function interpolateCompileTokens(ctx: ParseContext, value: string, path: Path): string {
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
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage("interp-unresolved", `Unclosed compile-time interpolation in "${value}"`),
        path,
      );
      output += value.slice(open);
      break;
    }

    const token = value.slice(open + 2, close).trim();
    const parsed = parseCompileExpr(token);
    if (!parsed) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage("interp-unresolved", `Cannot parse compile-time expression "${token}"`),
        path,
      );
      output += value.slice(open, close + 2);
      cursor = close + 2;
      continue;
    }

    const lookedUp = lookupSymbolValue(ctx, parsed.segments);
    if (!lookedUp.resolved) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "interp-unresolved",
          `Cannot resolve compile-time expression "${token}" from the symbol table`,
        ),
        path,
      );
      output += value.slice(open, close + 2);
      cursor = close + 2;
      continue;
    }

    const resolvedValue = lookedUp.value;
    if (parsed.asJson) {
      const json = JSON.stringify(resolvedValue);
      if (json === undefined) {
        pushDiagnostic(
          ctx,
          "error",
          diagnosticMessage(
            "interp-unresolved",
            `Cannot serialize compile-time expression "${token}" with toJSON(...)`,
          ),
          path,
        );
        output += value.slice(open, close + 2);
        cursor = close + 2;
        continue;
      }
      output += json;
      cursor = close + 2;
      continue;
    }

    if ((isObject(resolvedValue) || Array.isArray(resolvedValue)) && resolvedValue !== null) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "interp-non-scalar",
          `Expression "${token}" resolved to a non-scalar value; wrap it as {{ toJSON(...) }}`,
        ),
        path,
      );
      output += value.slice(open, close + 2);
      cursor = close + 2;
      continue;
    }

    output += String(resolvedValue);
    cursor = close + 2;
  }

  return output;
}

function resolveInterpolationsInTree(ctx: ParseContext, value: unknown, path: Path): unknown {
  if (typeof value === "string") {
    for (const expr of findRuntimeExpressions(value)) {
      if (containsParamsRootReference(expr)) {
        pushDiagnostic(
          ctx,
          "error",
          diagnosticMessage(
            "params-runtime-sigil",
            `Runtime expression "\${{ ${expr} }}" is invalid for params; use "{{ params.* }}"`,
          ),
          path,
        );
      }
    }

    const interpolated = interpolateCompileTokens(ctx, value, path);
    if (hasCompileToken(interpolated)) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "interp-unresolved",
          `Compile-time interpolation was left unresolved in "${interpolated}"`,
        ),
        path,
      );
    }
    return interpolated;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      value[index] = resolveInterpolationsInTree(ctx, value[index], [...path, index]);
    }
    return value;
  }

  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      value[key] = resolveInterpolationsInTree(ctx, child, [...path, key]);
    }
  }
  return value;
}

export function resolveCompileTimeInterpolations(ctx: ParseContext): void {
  resolveInterpolationsInTree(ctx, ctx.data, []);
}

/** Collect top-level typed params into the unified symbol table and strip them from output. */
export function paramsPass(ctx: ParseContext): void {
  const rawParams = ctx.data.params;
  if (rawParams === undefined) return;

  if (!isObject(rawParams)) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage("params-shape-invalid", "Top-level params must be a mapping"),
      ["params"],
    );
    delete ctx.data.params;
    return;
  }

  for (const [name, rawDefinition] of Object.entries(rawParams)) {
    const symbol = collectParamSymbol(ctx, name, rawDefinition, ["params", name]);
    if (!symbol) continue;
    ctx.symbols.set(symbol.name, symbol);
  }

  delete ctx.data.params;
}

/** Tier-0 pass: seed typed params before any other transform executes. */
export const params: Pass = { name: "params", apply: paramsPass };

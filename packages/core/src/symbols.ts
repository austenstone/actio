export type SymbolKind = "param-scalar" | "param-list" | "param-stepList" | "shared-output";

export type ParamType = "string" | "number" | "boolean" | "enum" | "object" | "stepList" | "steps";

export interface TaintFacet {
  tainted: boolean;
  derivedFrom: string[];
}

export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  type: ParamType;
  compileTimeKnown: boolean;
  hasDefault?: boolean;
  valueKnown?: boolean;
  required?: boolean;
  taint: TaintFacet;
  value?: unknown;
}

export type SymbolTable = Map<string, SymbolDef>;

export const RUNTIME_CONTEXT_ROOTS = [
  "github",
  "needs",
  "steps",
  "secrets",
  "env",
  "inputs",
  "vars",
  "runner",
  "job",
  "matrix",
  "strategy",
] as const;

export const RUNTIME_CONTEXT_ROOT_SET: ReadonlySet<string> = new Set(RUNTIME_CONTEXT_ROOTS);
/**
 * Conservative taint for COMPILE-TIME params: they are resolved and spliced at
 * compile time and are never derived from runtime-tainted inputs, so the safe
 * (conservative) facet here is `{ tainted: false }`.
 *
 * NOTE: the name describes the compile-time-param stance, NOT a general "assume
 * tainted" helper. Downstream runtime / shared-output passes (e.g. #23) must NOT
 * assume this propagates taint — they have to compute and thread taint through
 * their own derivations rather than reuse this constant.
 */
export function conservativeTaint(): TaintFacet {
  return { tainted: false, derivedFrom: [] };
}

const isIdentifierStart = (char: string): boolean => /[A-Za-z_]/.test(char);

const isIdentifierPart = (char: string): boolean => /[A-Za-z0-9_]/.test(char);

export function collectExpressionRoots(
  expression: string,
  rootsOfInterest?: ReadonlySet<string>,
): Set<string> {
  const roots = new Set<string>();
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (!char) continue;

    if (quote) {
      if (char !== quote) continue;
      if (quote === "'" && expression[index + 1] === "'") {
        index++;
        continue;
      }
      if (quote === '"' && expression[index - 1] === "\\") continue;
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
    while (end < expression.length && isIdentifierPart(expression[end] ?? "")) end++;
    const identifier = expression.slice(start, end);
    index = end - 1;

    let prev = start - 1;
    while (prev >= 0 && /\s/.test(expression[prev] ?? "")) prev--;
    if (prev >= 0 && expression[prev] === ".") continue;
    if (rootsOfInterest && !rootsOfInterest.has(identifier)) continue;
    roots.add(identifier);
  }
  return roots;
}

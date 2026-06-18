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

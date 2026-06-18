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

export function conservativeTaint(): TaintFacet {
  return { tainted: false, derivedFrom: [] };
}

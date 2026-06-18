import { NoOperationTraceWriter, parseWorkflow } from "@actions/workflow-parser";
import type { Diagnostic, Range } from "./diagnostics.js";

interface ParserPosition {
  line?: number;
  column?: number;
  col?: number;
}

interface ParserRange {
  start?: ParserPosition;
  end?: ParserPosition;
}

interface ParserErrorShape {
  rawMessage?: unknown;
  message?: unknown;
  range?: ParserRange;
  location?: ParserRange;
  context?: {
    errors?:
      | {
          getErrors?: () => unknown[];
          nodes?: unknown[];
        }
      | unknown[];
  };
}

function isParserErrorShape(value: unknown): value is ParserErrorShape {
  return typeof value === "object" && value !== null;
}

function collectErrors(result: ParserErrorShape): ParserErrorShape[] {
  const errs = result?.context?.errors;
  if (!errs) return [];
  if (!Array.isArray(errs)) {
    if (typeof errs.getErrors === "function") return errs.getErrors().filter(isParserErrorShape);
    if (Array.isArray(errs.nodes)) return errs.nodes.filter(isParserErrorShape);
    return [];
  }
  return errs.filter(isParserErrorShape);
}

function rangeOf(e: ParserErrorShape): Range | undefined {
  const r = e?.range ?? e?.location;
  if (r?.start && r?.end) {
    return {
      start: { line: r.start.line ?? 1, col: r.start.column ?? r.start.col ?? 1 },
      end: { line: r.end.line ?? 1, col: r.end.column ?? r.end.col ?? 1 },
    };
  }
  return undefined;
}

function cleanMessage(e: ParserErrorShape): string {
  const raw = String(e?.rawMessage ?? e?.message ?? e);
  // Strip a leading "file (Line: N, Col: M): " prefix if the parser embedded one.
  const m = raw.match(/\(Line:\s*\d+,\s*Col:\s*\d+\):\s*(.*)$/s);
  return m?.[1] ?? raw;
}

/**
 * Validate generated workflow YAML against GitHub's official embedded schema
 * via @actions/workflow-parser. Returns schema-level diagnostics (empty == valid).
 */
export function validateWorkflowYaml(yamlText: string, fileName: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let result: ParserErrorShape;
  try {
    result =
      (parseWorkflow({ name: fileName, content: yamlText }, new NoOperationTraceWriter()) as
        | ParserErrorShape
        | undefined) ?? {};
  } catch (e) {
    out.push({
      severity: "warning",
      source: "schema",
      file: fileName,
      message: `Could not validate generated workflow: ${(e as Error).message}`,
    });
    return out;
  }
  for (const e of collectErrors(result)) {
    out.push({
      severity: "error",
      source: "schema",
      file: fileName,
      message: cleanMessage(e),
      range: rangeOf(e),
    });
  }
  return out;
}

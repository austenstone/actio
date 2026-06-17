import { NoOperationTraceWriter, parseWorkflow } from "@actions/workflow-parser";
import type { Diagnostic, Range } from "./diagnostics.js";

// The error objects returned by @actions/workflow-parser are loosely typed across
// versions, so we probe defensively for message + range shapes.
// biome-ignore lint/suspicious/noExplicitAny: defensive interop with external error shapes
type AnyError = any;

function collectErrors(result: AnyError): AnyError[] {
  const errs = result?.context?.errors;
  if (!errs) return [];
  if (typeof errs.getErrors === "function") return errs.getErrors();
  if (Array.isArray(errs.nodes)) return errs.nodes;
  if (Array.isArray(errs)) return errs;
  return [];
}

function rangeOf(e: AnyError): Range | undefined {
  const r = e?.range ?? e?.location;
  if (r?.start && r?.end) {
    return {
      start: { line: r.start.line, col: r.start.column ?? r.start.col ?? 1 },
      end: { line: r.end.line, col: r.end.column ?? r.end.col ?? 1 },
    };
  }
  return undefined;
}

function cleanMessage(e: AnyError): string {
  const raw: string = e?.rawMessage ?? e?.message ?? String(e);
  // Strip a leading "file (Line: N, Col: M): " prefix if the parser embedded one.
  const m = raw.match(/\(Line:\s*\d+,\s*Col:\s*\d+\):\s*(.*)$/s);
  return m ? m[1] : raw;
}

/**
 * Validate generated workflow YAML against GitHub's official embedded schema
 * via @actions/workflow-parser. Returns schema-level diagnostics (empty == valid).
 */
export function validateWorkflowYaml(yamlText: string, fileName: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let result: AnyError;
  try {
    result = parseWorkflow({ name: fileName, content: yamlText }, new NoOperationTraceWriter());
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

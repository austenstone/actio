export type Severity = "error" | "warning";

export interface Position {
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  col: number;
}

export interface Range {
  start: Position;
  end: Position;
}

/** Where a diagnostic originated. */
export type DiagnosticSource = "yaml" | "actio" | "schema";

export interface Diagnostic {
  severity: Severity;
  message: string;
  /** Source file name (for display). */
  file?: string;
  /** Source range, when known. */
  range?: Range;
  /** Which layer produced the diagnostic. */
  source: DiagnosticSource;
  /** Optional actionable hint. */
  hint?: string;
}

/** Thrown when a caller prefers exceptions over a result object. */
export class ActioError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = "ActioError";
    this.diagnostics = diagnostics;
  }
}

function severityLabel(s: Severity): string {
  return s === "error" ? "error" : "warning";
}

/**
 * Render diagnostics as human-readable text, with a code frame when the
 * originating source is available in `sources` (keyed by file name).
 */
export function formatDiagnostics(
  diagnostics: Diagnostic[],
  sources: Record<string, string> = {},
): string {
  return diagnostics.map((d) => formatDiagnostic(d, sources[d.file ?? ""])).join("\n\n");
}

export function formatDiagnostic(d: Diagnostic, source?: string): string {
  const loc = d.range ? `:${d.range.start.line}:${d.range.start.col}` : "";
  const head = `${d.file ?? "<input>"}${loc} ${severityLabel(d.severity)}: ${d.message}`;
  const frame = source && d.range ? codeFrame(source, d.range) : "";
  const hint = d.hint ? `\n  hint: ${d.hint}` : "";
  return `${head}${frame ? `\n${frame}` : ""}${hint}`;
}

function codeFrame(source: string, range: Range): string {
  const lines = source.split(/\r?\n/);
  const lineNo = range.start.line;
  const idx = lineNo - 1;
  if (idx < 0 || idx >= lines.length) return "";
  const gutter = String(lineNo);
  const pad = " ".repeat(gutter.length);
  const text = lines[idx] ?? "";
  const startCol = Math.max(1, range.start.col);
  const sameLine = range.end.line === range.start.line;
  const endCol = sameLine ? Math.max(startCol + 1, range.end.col) : text.length + 1;
  const caretPad = " ".repeat(startCol - 1);
  const carets = "^".repeat(Math.max(1, endCol - startCol));
  return [`  ${gutter} | ${text}`, `  ${pad} | ${caretPad}${carets}`].join("\n");
}

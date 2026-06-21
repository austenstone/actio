export type Severity = "error" | "warning" | "info";

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
export type DiagnosticSource = "yaml" | "actio" | "schema" | "actionlint";

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
  /** Optional stable diagnostic code (e.g. `param-definition-invalid`). */
  code?: string;
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
  return s === "error" ? "error" : s === "warning" ? "warning" : "info";
}

/** The message body with the diagnostic code prefixed (`[code] message`) when set. */
function displayMessage(d: Diagnostic): string {
  return d.code ? `[${d.code}] ${d.message}` : d.message;
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
  const head = `${d.file ?? "<input>"}${loc} ${severityLabel(d.severity)}: ${displayMessage(d)}`;
  const frame = source && d.range ? codeFrame(source, d.range) : "";
  const hint = d.hint ? `\n  hint: ${d.hint}` : "";
  return `${head}${frame ? `\n${frame}` : ""}${hint}`;
}

/** Escape data for a workflow command body (`::cmd::<data>`). */
function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escape a workflow command property value (`file=...`, `title=...`). */
function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/**
 * Render a diagnostic as a GitHub Actions workflow command so it surfaces as an
 * inline annotation on the originating `.actio.yml` source line. Relies on the
 * diagnostic's range already being source-mapped (see `transpile`'s `sourceMap`).
 */
export function formatGithubAnnotation(d: Diagnostic): string {
  const cmd = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "notice";
  const props: string[] = [];
  if (d.file) props.push(`file=${escapeProperty(d.file)}`);
  if (d.range) {
    props.push(`line=${d.range.start.line}`, `col=${d.range.start.col}`);
    const multi = d.range.end.line !== d.range.start.line || d.range.end.col !== d.range.start.col;
    if (multi) props.push(`endLine=${d.range.end.line}`, `endColumn=${d.range.end.col}`);
  }
  props.push(`title=${escapeProperty(`actio (${d.source})`)}`);
  const body = displayMessage(d);
  const message = d.hint ? `${body}\n\nhint: ${d.hint}` : body;
  return `::${cmd} ${props.join(",")}::${escapeData(message)}`;
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

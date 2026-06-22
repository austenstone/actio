// Browser-safe entry for actio-core: the compile/expand surface only. Its
// transitive import graph must stay free of node builtins (no schema.ts fs/url,
// no lint.ts child_process), so the docs playground bundles it without the
// node-builtin stubs that the full `index` entry requires (#155). `transpile`
// runs the whole built-in pass pipeline, so a new pass added there flows into
// the browser bundle automatically with no edits here.
export {
  ActioError,
  type Diagnostic,
  type DiagnosticSource,
  formatDiagnostic,
  formatDiagnostics,
  formatGithubAnnotation,
  type Position,
  type Range,
  type Severity,
} from "./diagnostics.js";
export {
  type NativeDependencies,
  type NativeDependencyEntry,
  type TranspileOptions,
  type TranspileResult,
  transpile,
} from "./transpile.js";

export { type ActioConfig, type ActioTarget, defineConfig } from "./config.js";
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
export { type EmitOptions, emitYaml, generatedHeader } from "./emit.js";
export {
  cloneNode,
  deriveNode,
  type Job,
  type JobView,
  type Origin,
  originOf,
  recordOrigin,
  type Step,
  type StepView,
  seedOrigins,
  setOrigin,
  transformSteps,
  visitJobs,
  visitSteps,
  type Workflow,
  workflow,
} from "./ir.js";
export {
  type ParseContext,
  type Path,
  parseActio,
  rangeOfPath,
  type WorkflowData,
} from "./parser.js";
export {
  ANNOTATE_ACTION,
  ANNOTATE_JOB_ID,
  annotate,
  applyPasses,
  builtinPasses,
  createRegistry,
  dynamicMatrix,
  fallback,
  fragments,
  type Pass,
  type PassFn,
  PassRegistry,
  retry,
  runPasses,
  sortPasses,
} from "./passes/index.js";
export {
  ACTIO_SCHEMA_URL,
  actioSchema,
  actioSchemaJson,
  actioSchemaPath,
  SCHEMA_MODELINE,
} from "./schema.js";
export {
  type BuildSourceMapOptions,
  buildSourceMap,
  resolveGeneratedLine,
  type SourceMap,
  type SourceMapping,
} from "./sourcemap.js";
export {
  type NativeDependencies,
  type NativeDependencyEntry,
  type TranspileOptions,
  type TranspileResult,
  transpile,
} from "./transpile.js";
export { validateWorkflowYaml } from "./validate.js";

export { defaultActionlintRunner, type SpawnSync } from "./actionlint.js";
export {
  COERCION_CATEGORY_HINTS,
  COERCION_MODES,
  type CoercionCategory,
  type CoercionMode,
  coercionTrapCategory,
  coercionWarning,
} from "./coercion.js";
export {
  type ActioConfig,
  type ActioTarget,
  defineConfig,
  type PermissionsConfig,
  type PermissionsMode,
  type PinConfig,
} from "./config.js";
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
  conservativeTaint,
  deriveNode,
  type Job,
  type JobView,
  type Origin,
  originOf,
  type ParamType,
  recordOrigin,
  type Step,
  type StepView,
  type SymbolDef,
  type SymbolKind,
  type SymbolTable,
  seedOrigins,
  setOrigin,
  type TaintFacet,
  transformSteps,
  visitJobs,
  visitSteps,
  type Workflow,
  workflow,
} from "./ir.js";
export {
  type ActionlintFinding,
  type ActionlintRun,
  type ActionlintRunner,
  LINT_MODES,
  type LintMode,
  lintWorkflowYaml,
} from "./lint.js";
export type { ModuleResolver, ResolvedModule } from "./modules.js";
export {
  type ForEachShareContract,
  type ForEachShareContractEntry,
  type JobDefaultsInternalSnapshot,
  type ParseContext,
  type ParseContextInternal,
  type Path,
  parseActio,
  rangeOfPath,
  type WorkflowData,
} from "./parser.js";
export {
  ANNOTATE_ACTION,
  ANNOTATE_JOB_ID,
  annotate,
  applyDefaults,
  applyExecutor,
  applyPasses,
  builtinPasses,
  CALL_TEMPLATE_KEYS,
  type CallTemplateKey,
  callTemplates,
  createRegistry,
  deepMerge,
  dynamicMatrix,
  EXECUTOR_KEYS,
  type ExecutorKey,
  expandMatrix,
  fallback,
  forEach,
  fragments,
  importPass,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_SAFE_SUBSET,
  type JobDefaultKey,
  jobDefaults,
  lifecycle,
  type Pass,
  type PassFn,
  PassRegistry,
  params,
  retry,
  runPasses,
  sortPasses,
} from "./passes/index.js";
export {
  permissions,
  permissionsPass,
  type ScopeLevel,
  type ScopeMap,
} from "./passes/permissions.js";
export {
  applyPins,
  type PinCommentStyle,
  type PinOptions,
  type PinPolicy,
  type PinResolution,
  type PinTarget,
  parseUsesRef,
  pinCommentText,
  shouldPinTarget,
} from "./passes/pin.js";
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
export { collectMergeKeyDiagnostics } from "./strict.js";
export {
  type NativeDependencies,
  type NativeDependencyEntry,
  type TranspileOptions,
  type TranspileResult,
  transpile,
} from "./transpile.js";
export {
  collectUnusedSymbolDiagnostics,
  type UnusedSymbolsMode,
} from "./unusedSymbols.js";
export { validateWorkflowYaml } from "./validate.js";

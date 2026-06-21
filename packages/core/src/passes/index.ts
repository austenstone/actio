import type { ParseContext } from "../parser.js";
import { CALL_TEMPLATE_KEYS, type CallTemplateKey, callTemplates } from "./callTemplates.js";
import { dynamicMatrix } from "./dynamicMatrix.js";
import { expandMatrix } from "./expandMatrix.js";
import { fallback } from "./fallback.js";
import { forEach } from "./forEach.js";
import { fragments } from "./fragments.js";
import { ifChanged } from "./ifChanged.js";
import { injectionHoist } from "./injectionHoist.js";
import {
  applyDefaults,
  applyExecutor,
  EXECUTOR_KEYS,
  type ExecutorKey,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_SAFE_SUBSET,
  type JobDefaultKey,
  jobDefaults,
} from "./jobDefaults.js";
import { lifecycle } from "./lifecycle.js";
import { params } from "./params.js";
import { type Pass, PassRegistry, runCompletePassPipeline } from "./registry.js";
import { retry } from "./retry.js";
import { reusable } from "./reusable.js";
import { share } from "./share.js";
import { whenCompile } from "./whenCompile.js";

/**
 * The transforms Actio ships with. Order is derived from each pass's `runsAfter`
 * (see registry.ts), not this array, so the effective pipeline is:
 *   params → call-templates → job-defaults → for-each → when-compile → fragments → share → retry → fallback → dynamic-matrix → expand-matrix → lifecycle → if-changed → injection-hoist
 *
 * `reusable` runs right after `params` so its input-reference normalization sees
 * fully resolved compile-time text before the call/normal job partition.
 *
 * `call-templates` slots in immediately after `params` (and before `job-defaults`)
 * so `extends:` materializes `uses` before the call/normal job partition.
 */
export const builtinPasses: Pass[] = [
  params,
  reusable,
  callTemplates,
  jobDefaults,
  forEach,
  whenCompile,
  fragments,
  share,
  retry,
  fallback,
  dynamicMatrix,
  expandMatrix,
  lifecycle,
  ifChanged,
  injectionHoist,
];

/**
 * Run pass transforms (defaults to the built-ins), then resolve final
 * compile-time text interpolation.
 *
 * Use `applyPasses()` only when you specifically need the raw pass-only stage.
 */
export function runPasses(ctx: ParseContext, passes: Pass[] = builtinPasses): void {
  runCompletePassPipeline(ctx, passes);
}

/**
 * A registry seeded with the built-in passes, ready for extra ones to be added.
 * A caller-supplied pass whose name matches a built-in replaces that built-in,
 * so the pipeline can be customized without `register()` throwing on the clash.
 * (`register()` itself stays strict; the dedupe happens here at the merge layer.)
 */
export function createRegistry(extra: Pass[] = []): PassRegistry {
  const overridden = new Set(extra.map((pass) => pass.name));
  const base = builtinPasses.filter((pass) => !overridden.has(pass.name));
  return new PassRegistry([...base, ...extra]);
}

export { ANNOTATE_ACTION, ANNOTATE_JOB_ID, annotate } from "./annotate.js";
export {
  applyPasses,
  type Pass,
  type PassFn,
  PassRegistry,
  sortPasses,
} from "./registry.js";
export {
  applyDefaults,
  applyExecutor,
  CALL_TEMPLATE_KEYS,
  type CallTemplateKey,
  callTemplates,
  dynamicMatrix,
  EXECUTOR_KEYS,
  type ExecutorKey,
  expandMatrix,
  fallback,
  forEach,
  fragments,
  ifChanged,
  injectionHoist,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_SAFE_SUBSET,
  type JobDefaultKey,
  jobDefaults,
  lifecycle,
  params,
  retry,
  reusable,
  share,
  whenCompile,
};

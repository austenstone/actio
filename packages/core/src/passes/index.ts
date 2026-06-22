import type { ParseContext } from "../parser.js";
import { artifacts } from "./artifacts.js";
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
import { referenceLower, referenceWire } from "./reference.js";
import { type Pass, PassRegistry, runCompletePassPipeline } from "./registry.js";
import { retry } from "./retry.js";
import { reusable } from "./reusable.js";
import { share, shareMatrixCheck } from "./share.js";
import { softFail } from "./softFail.js";
import { whenCompile } from "./whenCompile.js";

/**
 * The transforms Actio ships with. Order is derived from each pass's `runsAfter`
 * (see registry.ts), not this array, so the effective pipeline is:
 *   params → call-templates → job-defaults → for-each → when-compile → fragments → artifacts → share → reference-lower → retry → fallback → soft-fail → dynamic-matrix → expand-matrix → lifecycle → if-changed → injection-hoist → share-matrix-check → reference-wire
 *
 * `reusable` runs right after `params` so its input-reference normalization sees
 * fully resolved compile-time text before the call/normal job partition.
 *
 * `call-templates` slots in immediately after `params` (and before `job-defaults`)
 * so `extends:` materializes `uses` before the call/normal job partition.
 *
 * `artifacts` runs after `fragments` (so fragment/injected steps carrying
 * `artifacts:` also expand) and before `retry` (so a retried step fans out only
 * its run, not a duplicate uploader per attempt).
 *
 * `share-matrix-check` runs after both matrix passes so the matrix-output clobber
 * guard sees the final matrix shape, including matrices injected by `dynamic-matrix`
 * after `share` already wired the outputs (#158).
 *
 * `reference-lower` runs after `share` (it reuses share's wire engine and the
 * `fragments` slot) and rewrites every `${{ ref.* }}` consumer; `reference-wire`
 * runs last, after every matrix/lifecycle pass, so its cross-job `job.outputs`
 * synthesis and matrix-clobber guard see the settled matrix shape (#160).
 */
export const builtinPasses: Pass[] = [
  params,
  reusable,
  callTemplates,
  jobDefaults,
  forEach,
  whenCompile,
  fragments,
  artifacts,
  share,
  referenceLower,
  retry,
  fallback,
  softFail,
  dynamicMatrix,
  expandMatrix,
  lifecycle,
  ifChanged,
  injectionHoist,
  shareMatrixCheck,
  referenceWire,
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
  artifacts,
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
  referenceLower,
  referenceWire,
  retry,
  reusable,
  share,
  shareMatrixCheck,
  softFail,
  whenCompile,
};

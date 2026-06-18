import type { ParseContext } from "../parser.js";
import { dynamicMatrix } from "./dynamicMatrix.js";
import { fallback } from "./fallback.js";
import { forEach } from "./forEach.js";
import { fragments } from "./fragments.js";
import {
  applyDefaults,
  applyExecutor,
  EXECUTOR_KEYS,
  JOB_DEFAULTS_SAFE_SUBSET,
  jobDefaults,
} from "./jobDefaults.js";
import { lifecycle } from "./lifecycle.js";
import { params } from "./params.js";
import { applyPasses, type Pass, PassRegistry } from "./registry.js";
import { retry } from "./retry.js";
import { whenCompile } from "./whenCompile.js";

/**
 * The transforms Actio ships with. Order is derived from each pass's `runsAfter`
 * (see registry.ts), not this array, so the effective pipeline is:
 *   params → job_defaults → for_each → when_compile → fragments → retry → fallback → dynamic_matrix
 */
export const builtinPasses: Pass[] = [
  params,
  jobDefaults,
  forEach,
  whenCompile,
  fragments,
  retry,
  fallback,
  dynamicMatrix,
  lifecycle,
];

/** Run a set of passes (defaults to the built-ins) in dependency order. */
export function runPasses(ctx: ParseContext, passes: Pass[] = builtinPasses): void {
  applyPasses(ctx, passes);
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
  dynamicMatrix,
  EXECUTOR_KEYS,
  fallback,
  forEach,
  fragments,
  JOB_DEFAULTS_SAFE_SUBSET,
  jobDefaults,
  lifecycle,
  params,
  retry,
  whenCompile,
};

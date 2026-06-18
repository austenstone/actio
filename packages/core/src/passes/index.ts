import type { ParseContext } from "../parser.js";
import { dynamicMatrix } from "./dynamicMatrix.js";
import { fallback } from "./fallback.js";
import { fragments } from "./fragments.js";
import { params } from "./params.js";
import { jobDefaults } from "./jobDefaults.js";
import { applyPasses, type Pass, PassRegistry } from "./registry.js";
import { retry } from "./retry.js";

/**
 * The transforms Actio ships with. Order is derived from each pass's `runsAfter`
 * (see registry.ts), not this array, so the effective pipeline is:
 *   params → job_defaults → fragments → retry → fallback → dynamic_matrix
 */
export const builtinPasses: Pass[] = [
  params,
  jobDefaults,
  fragments,
  retry,
  fallback,
  dynamicMatrix,
];

/** Run a set of passes (defaults to the built-ins) in dependency order. */
export function runPasses(ctx: ParseContext, passes: Pass[] = builtinPasses): void {
  applyPasses(ctx, passes);
}

/** A registry seeded with the built-in passes, ready for extra ones to be added. */
export function createRegistry(extra: Pass[] = []): PassRegistry {
  return new PassRegistry([...builtinPasses, ...extra]);
}

export { ANNOTATE_ACTION, ANNOTATE_JOB_ID, annotate } from "./annotate.js";
export {
  applyPasses,
  type Pass,
  type PassFn,
  PassRegistry,
  sortPasses,
} from "./registry.js";
export { dynamicMatrix, fallback, fragments, jobDefaults, params, retry };

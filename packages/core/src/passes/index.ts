import type { ParseContext } from "../parser.js";
import { dynamicMatrixPass } from "./dynamicMatrix.js";
import { fallbackPass } from "./fallback.js";
import { fragmentsPass } from "./fragments.js";

export type Pass = (ctx: ParseContext) => void;

/**
 * Ordered transform pipeline. Order matters:
 *  1. fragments  — splice reusable steps in first, so later passes see real steps.
 *  2. fallback   — wrap steps with try/catch before they're moved between jobs.
 *  3. dynamic_matrix — split jobs and move the (already finalized) steps.
 */
export const passes: Pass[] = [fragmentsPass, fallbackPass, dynamicMatrixPass];

export function runPasses(ctx: ParseContext): void {
  for (const pass of passes) {
    pass(ctx);
  }
}

export { dynamicMatrixPass, fallbackPass, fragmentsPass };

import { cloneNode, type Job, type Step, visitJobs } from "../ir.js";
import type { ParseContext } from "../parser.js";
import { asArray, isObject, pushDiagnostic } from "./helpers.js";
import type { Pass } from "./registry.js";

type FragmentMap = Record<string, Step[]>;

function getFragments(ctx: ParseContext): FragmentMap {
  const frags = ctx.data.fragments;
  const out: FragmentMap = {};
  if (isObject(frags)) {
    for (const [name, steps] of Object.entries(frags)) {
      out[name] = asArray(steps as Step | Step[]);
    }
  }
  return out;
}

function isInject(step: unknown): step is Step & { inject: string } {
  return isObject(step) && typeof (step as Step).inject === "string";
}

/** Expand a list of steps, splicing in fragment steps for every `inject:` entry. */
function expandList(
  list: Step[],
  ctx: ParseContext,
  fragments: FragmentMap,
  stack: string[],
): Step[] {
  const out: Step[] = [];
  for (const step of list) {
    if (isInject(step)) {
      const name = step.inject;
      const extraKeys = Object.keys(step).filter((k) => k !== "inject");
      if (extraKeys.length > 0) {
        pushDiagnostic(
          ctx,
          "warning",
          `inject of "${name}" ignores extra keys (${extraKeys.join(", ")}); parameterized fragments are not supported yet`,
        );
      }
      if (!(name in fragments)) {
        pushDiagnostic(ctx, "error", `Unknown fragment "${name}"`, undefined, {
          hint: `Define it under top-level "fragments:" (available: ${
            Object.keys(fragments).join(", ") || "none"
          })`,
        });
        continue;
      }
      if (stack.includes(name)) {
        pushDiagnostic(ctx, "error", `Fragment cycle detected: ${[...stack, name].join(" -> ")}`);
        continue;
      }
      const copies = fragments[name].map((s) => cloneNode(ctx, s));
      out.push(...expandList(copies, ctx, fragments, [...stack, name]));
    } else {
      if (isObject(step) && step.fallback != null) {
        expandFallbackInPlace(step, ctx, fragments, stack);
      }
      out.push(step);
    }
  }
  return out;
}

/** Expand inject entries that live inside a step- or job-level `fallback` block. */
function expandFallbackInPlace(
  container: Step | Job,
  ctx: ParseContext,
  fragments: FragmentMap,
  stack: string[],
): void {
  const fb = container.fallback;
  if (Array.isArray(fb)) {
    container.fallback = expandList(fb, ctx, fragments, stack);
  } else if (isObject(fb) && Array.isArray((fb as Step).steps)) {
    (fb as Step).steps = expandList((fb as Step).steps, ctx, fragments, stack);
  }
}

/**
 * fragments pass: collect top-level `fragments:`, expand all `- inject: <name>`
 * entries (in job steps, job fallback, and step fallback), then strip the
 * `fragments:` key. Runs before other passes so later passes see real steps.
 */
export function fragmentsPass(ctx: ParseContext): void {
  const fragments = getFragments(ctx);
  visitJobs(ctx, ({ job }) => {
    if (Array.isArray(job.steps)) {
      job.steps = expandList(job.steps, ctx, fragments, []);
    }
    if (job.fallback != null) {
      expandFallbackInPlace(job, ctx, fragments, []);
    }
  });
  delete ctx.data.fragments;
}

/** Splice reusable `inject:` steps in first, so later passes see real steps. */
export const fragments: Pass = { name: "fragments", apply: fragmentsPass };

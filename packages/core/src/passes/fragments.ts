import { cloneNode, type Job, type Step, visitJobs } from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import { asStepArray, isObject, pushDiagnostic } from "./helpers.js";
import { resolveCompileTimeTextBoundaries } from "./params.js";
import type { Pass } from "./registry.js";

type FragmentMap = Record<string, Step[]>;
const FORM_B_KEY_RE = /^when_compile\([\s\S]*\)$/;
const diagnosticMessage = (code: string, message: string): string => `[${code}] ${message}`;

function getFragments(ctx: ParseContext): FragmentMap {
  const frags = ctx.data.fragments;
  const out: FragmentMap = {};
  if (isObject(frags)) {
    for (const [name, steps] of Object.entries(frags)) {
      out[name] = asStepArray(steps);
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
      const copies = (fragments[name] ?? []).map((s) => cloneNode(ctx, s));
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
    container.fallback = expandList(asStepArray(fb), ctx, fragments, stack);
  } else if (isObject(fb) && Array.isArray(fb.steps)) {
    fb.steps = expandList(asStepArray(fb.steps), ctx, fragments, stack);
  }
}

function stripResidualWhenCompile(ctx: ParseContext, value: unknown, path: Path): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      stripResidualWhenCompile(ctx, item, [...path, index]);
    });
    return;
  }
  if (!isObject(value)) return;

  for (const key of Object.keys(value)) {
    if (key === "when_compile" || FORM_B_KEY_RE.test(key)) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "when-compile-residual",
          "Residual when_compile directive is not allowed here; move it to a job/step structural position",
        ),
        [...path, key],
      );
      delete value[key];
      continue;
    }
    stripResidualWhenCompile(ctx, value[key], [...path, key]);
  }
}

/**
 * fragments pass: collect top-level `fragments:`, expand all `- inject: <name>`
 * entries (in job steps, job fallback, and step fallback), then strip the
 * `fragments:` key. Runs after when_compile and strips any residual when_compile
 * directives that reach this stage.
 */
export function fragmentsPass(ctx: ParseContext): void {
  const fragments = getFragments(ctx);
  visitJobs(ctx, ({ id, job }) => {
    if (Array.isArray(job.steps)) {
      job.steps = expandList(job.steps, ctx, fragments, []);
    }
    if (job.fallback != null) {
      expandFallbackInPlace(job, ctx, fragments, []);
    }
    resolveCompileTimeTextBoundaries(ctx, job, ["jobs", id], {
      validateRuntimeExpressions: false,
      enforceNoResidualTokens: false,
      reportInterpolationErrors: false,
    });
    stripResidualWhenCompile(ctx, job, ["jobs", id]);
  });
  delete ctx.data.fragments;
}

/** Splice reusable `inject:` steps in first, so later passes see real steps. */
export const fragments: Pass = {
  name: "fragments",
  runsAfter: ["params", "when_compile"],
  apply: fragmentsPass,
};

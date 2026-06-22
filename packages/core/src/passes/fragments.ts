import { cloneNode, type Job, type Step, visitJobs } from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import { asStepArray, isObject, pushDiagnostic, sourcePathFor } from "./helpers.js";
import { resolveCompileTimeTextBoundaries } from "./params.js";
import type { Pass } from "./registry.js";

type FragmentMap = Record<string, Step[]>;
const FORM_B_KEY_RE = /^static-if\([\s\S]*\)$/;
// A `- *alias` whose anchor is a sequence parses to a nested array at a step
// position; flatten splices it in place. The cap is a defensive guard against
// pathologically deep nesting (YAML aliases cannot form cycles).
const FLATTEN_DEPTH_CAP = 64;
const diagnosticMessage = (code: string, message: string): string => `[${code}] ${message}`;

// Coerce a fallback step list while preserving spliced `*alias` sequences
// (nested arrays). Plain asStepArray drops arrays via filter(isObject), which
// would silently delete a `- *alias` before the flatten branch can splice it.
const asFlattenableSteps = (value: unknown): Step[] =>
  (Array.isArray(value) ? value : []).filter((s) => isObject(s) || Array.isArray(s)) as Step[];

function getFragments(ctx: ParseContext): FragmentMap {
  const frags = ctx.data.fragments;
  const out: FragmentMap = {};
  if (frags === undefined) return out;
  if (!isObject(frags)) {
    pushDiagnostic(
      ctx,
      "warning",
      `top-level "fragments" must be a mapping of name -> steps (got ${
        frags === null ? "null" : Array.isArray(frags) ? "array" : typeof frags
      }); ignoring`,
      ["fragments"],
    );
    return out;
  }
  for (const [name, steps] of Object.entries(frags)) {
    if (!Array.isArray(steps)) {
      pushDiagnostic(
        ctx,
        "warning",
        `fragment "${name}" must be a list of steps (got ${
          steps === null ? "null" : typeof steps
        }); treating as empty`,
        ["fragments", name],
      );
      out[name] = [];
      continue;
    }
    out[name] = asStepArray(steps);
  }
  return out;
}

function isInject(step: unknown): step is Step & { inject: string } {
  return isObject(step) && typeof (step as Step).inject === "string";
}

/** A step carrying a non-string `inject:` is a malformed inject directive. */
function hasBadInject(step: unknown): boolean {
  return isObject(step) && "inject" in step && typeof (step as Step).inject !== "string";
}

/** Expand a list of steps, splicing in fragment steps for every `inject:` entry. */
function expandList(
  list: Step[],
  ctx: ParseContext,
  fragments: FragmentMap,
  stack: string[],
  listPath?: Path,
  depth = 0,
): Step[] {
  if (depth > FLATTEN_DEPTH_CAP) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "template-depth-exceeded",
        `spliced step nesting exceeded the depth cap of ${FLATTEN_DEPTH_CAP}`,
      ),
      listPath ? sourcePathFor(ctx, list, listPath) : undefined,
    );
    return [];
  }
  const out: Step[] = [];
  for (const [index, step] of list.entries()) {
    const stepPath = listPath ? [...listPath, index] : undefined;
    if (Array.isArray(step)) {
      out.push(...expandList(step as Step[], ctx, fragments, stack, stepPath, depth + 1));
      continue;
    }
    if (hasBadInject(step)) {
      pushDiagnostic(
        ctx,
        "error",
        `inject must name a fragment as a string (got ${typeof (step as Step).inject})`,
        sourcePathFor(ctx, step, stepPath),
      );
      continue;
    }
    if (isInject(step)) {
      const name = step.inject;
      const extraKeys = Object.keys(step).filter((k) => k !== "inject");
      if (extraKeys.length > 0) {
        pushDiagnostic(
          ctx,
          "warning",
          `inject of "${name}" ignores extra keys (${extraKeys.join(", ")}); parameterized fragments are not supported yet`,
          sourcePathFor(ctx, step, stepPath, [extraKeys[0] ?? "inject"]),
        );
      }
      if (!(name in fragments)) {
        pushDiagnostic(
          ctx,
          "error",
          `Unknown fragment "${name}"`,
          sourcePathFor(ctx, step, stepPath, ["inject"]),
          {
            hint: `Define it under top-level "fragments:" (available: ${
              Object.keys(fragments).join(", ") || "none"
            })`,
          },
        );
        continue;
      }
      if (stack.includes(name)) {
        pushDiagnostic(
          ctx,
          "error",
          `Fragment cycle detected: ${[...stack, name].join(" -> ")}`,
          sourcePathFor(ctx, step, stepPath, ["inject"]),
        );
        continue;
      }
      const copies = (fragments[name] ?? []).map((s) => cloneNode(ctx, s));
      out.push(...expandList(copies, ctx, fragments, [...stack, name], undefined, depth));
    } else {
      if (isObject(step) && step.fallback != null) {
        expandFallbackInPlace(step, ctx, fragments, stack, sourcePathFor(ctx, step, stepPath));
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
  containerPath?: Path,
): void {
  const fb = container.fallback;
  if (Array.isArray(fb)) {
    container.fallback = expandList(
      asFlattenableSteps(fb),
      ctx,
      fragments,
      stack,
      containerPath ? [...containerPath, "fallback"] : undefined,
    );
  } else if (isObject(fb) && Array.isArray(fb.steps)) {
    fb.steps = expandList(
      asFlattenableSteps(fb.steps),
      ctx,
      fragments,
      stack,
      containerPath ? [...containerPath, "fallback", "steps"] : undefined,
    );
  }
}

function stripResidualWhenCompile(ctx: ParseContext, value: unknown, path: Path): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (Array.isArray(item)) {
        // A spliced `- *alias` step-sequence materializes as a nested array of
        // step mappings. Literal nested arrays (e.g. a matrix axis `[[1,2]]`)
        // hold scalars, so only an all-object inner array is a flatten misuse.
        if (item.length > 0 && item.every(isObject)) {
          pushDiagnostic(
            ctx,
            "error",
            diagnosticMessage(
              "template-flatten-nonstep",
              "a `- *alias` sequence can only flatten inside a steps list (job steps, fallback, or fallback.steps); remove it or move it to a steps position",
            ),
            sourcePathFor(ctx, item, [...path, index]),
          );
          return;
        }
        stripResidualWhenCompile(ctx, item, [...path, index]);
        return;
      }
      stripResidualWhenCompile(ctx, item, [...path, index]);
    });
    return;
  }
  if (!isObject(value)) return;

  for (const key of Object.keys(value)) {
    if (key === "static-if" || FORM_B_KEY_RE.test(key)) {
      const diagnosticPath = sourcePathFor(ctx, value, path, [key]);
      const message =
        diagnosticPath?.[0] === "fragments"
          ? "Residual static-if directive is not allowed inside fragments; gate the inject site or move it to a concrete job/step"
          : "Residual static-if directive is not allowed here; move it to a job/step structural position";
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage("static-if-residual", message),
        diagnosticPath,
      );
      delete value[key];
      continue;
    }
    if (path.length === 0 && key === "jobs") {
      continue;
    }
    stripResidualWhenCompile(ctx, value[key], [...path, key]);
  }
}

/**
 * fragments pass: collect top-level `fragments:`, expand all `- inject: <name>`
 * entries (in job steps, job fallback, and step fallback), flatten any spliced
 * `- *alias` sequences in those step lists, then strip the `fragments:` and
 * reserved `_anchors:` keys. Runs after static-if and strips any residual
 * static-if directives that reach this stage.
 */
export function fragmentsPass(ctx: ParseContext): void {
  const fragments = getFragments(ctx);
  visitJobs(ctx, ({ id, job }) => {
    if (Array.isArray(job.steps)) {
      job.steps = expandList(job.steps, ctx, fragments, [], ["jobs", id, "steps"]);
    }
    if (job.fallback != null) {
      expandFallbackInPlace(job, ctx, fragments, [], sourcePathFor(ctx, job, ["jobs", id]));
    }
    resolveCompileTimeTextBoundaries(ctx, job, ["jobs", id], {
      validateRuntimeExpressions: false,
      enforceNoResidualTokens: false,
      reportInterpolationErrors: false,
    });
    stripResidualWhenCompile(ctx, job, ["jobs", id]);
  });
  delete ctx.data.fragments;
  delete ctx.data._anchors;
  stripResidualWhenCompile(ctx, ctx.data, []);
}

/** Splice reusable `inject:` steps in first, so later passes see real steps. */
export const fragments: Pass = {
  name: "fragments",
  runsAfter: ["params", "when-compile"],
  apply: fragmentsPass,
};

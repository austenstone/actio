import { cloneNode, type Job, type ParamType, type Step, visitJobs } from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import { asStepArray, isObject, pushDiagnostic, sourcePathFor } from "./helpers.js";
import {
  PARAM_TYPES,
  resolveArgsInBody,
  resolveCompileTimeTextBoundaries,
  type TemplateArg,
  validateEnumValues,
  valueMatchesParamType,
} from "./params.js";
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

/** A declared template parameter (mirrors the params: type system). */
interface TemplateParam {
  name: string;
  type: ParamType;
  values?: string[];
  required: boolean;
  default: unknown;
}

interface Template {
  params: TemplateParam[];
  steps: Step[];
}

type TemplateMap = Record<string, Template>;

// `inject: ./lib#name` reserves the cross-file selector for Bet 2 (#161); any
// bare in-file template name matches [A-Za-z_][A-Za-z0-9_-]* and so never
// contains `/` or `#`.
function isCrossFileInject(name: string): boolean {
  return name.includes("#") || name.includes("/");
}

// Validate a template's `params:` block, reusing the shared PARAM_TYPES system.
function parseTemplateParams(ctx: ParseContext, name: string, raw: unknown): TemplateParam[] {
  if (raw === undefined) return [];
  if (!isObject(raw)) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage("template-param-invalid", `template "${name}" params must be a mapping`),
      ["templates", name, "params"],
    );
    return [];
  }
  const out: TemplateParam[] = [];
  for (const [paramName, def] of Object.entries(raw)) {
    const path: Path = ["templates", name, "params", paramName];
    if (!isObject(def)) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "template-param-invalid",
          `template "${name}" param "${paramName}" must be an object definition`,
        ),
        path,
      );
      continue;
    }
    const typeRaw = def.type;
    if (typeof typeRaw !== "string" || !PARAM_TYPES.has(typeRaw as ParamType)) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "template-param-type",
          `template "${name}" param "${paramName}".type must be one of ${[...PARAM_TYPES].join(", ")}`,
        ),
        [...path, "type"],
      );
      continue;
    }
    const type = typeRaw as ParamType;
    const values = validateEnumValues(def.values);
    if (type === "enum" && !values) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "template-param-type",
          `template "${name}" param "${paramName}".values must be a non-empty string array when type is enum`,
        ),
        [...path, "values"],
      );
      continue;
    }
    const hasDefault = Object.hasOwn(def, "default");
    if (hasDefault && !valueMatchesParamType(type, def.default)) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "template-param-type",
          `template "${name}" param "${paramName}".default does not match declared type "${type}"`,
        ),
        [...path, "default"],
      );
      continue;
    }
    if (hasDefault && type === "enum" && values && !values.includes(def.default as string)) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "template-param-type",
          `template "${name}" param "${paramName}".default must be one of [${values.join(", ")}]`,
        ),
        [...path, "default"],
      );
      continue;
    }
    out.push({ name: paramName, type, values, required: !hasDefault, default: def.default });
  }
  return out;
}

function getTemplates(ctx: ParseContext): TemplateMap {
  const raw = ctx.data.templates;
  const out: TemplateMap = {};
  if (raw === undefined) return out;
  if (!isObject(raw)) {
    pushDiagnostic(
      ctx,
      "warning",
      `top-level "templates" must be a mapping of name -> definition (got ${
        raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw
      }); ignoring`,
      ["templates"],
    );
    return out;
  }
  for (const [name, def] of Object.entries(raw)) {
    if (!isObject(def)) {
      pushDiagnostic(
        ctx,
        "warning",
        `template "${name}" must be an object with steps (got ${
          def === null ? "null" : typeof def
        }); ignoring`,
        ["templates", name],
      );
      continue;
    }
    if (!Array.isArray(def.steps)) {
      pushDiagnostic(ctx, "warning", `template "${name}" must declare a steps list; ignoring`, [
        "templates",
        name,
      ]);
      continue;
    }
    out[name] = {
      params: parseTemplateParams(ctx, name, def.params),
      steps: asStepArray(def.steps),
    };
  }
  return out;
}

// Validate `with:` against the template's declared params; return the resolved
// arg frame (defaults applied) or undefined if any diagnostic was emitted.
function validateTemplateArgs(
  ctx: ParseContext,
  name: string,
  template: Template,
  step: Step,
  stepPath?: Path,
): Record<string, TemplateArg> | undefined {
  const withRaw = (step as Record<string, unknown>).with;
  if (withRaw !== undefined && !isObject(withRaw)) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage("template-arg-type", `inject of "${name}" with: must be a mapping`),
      sourcePathFor(ctx, step, stepPath, ["with"]),
    );
    return undefined;
  }
  const provided = (withRaw ?? {}) as Record<string, unknown>;
  const declared = new Set(template.params.map((p) => p.name));
  let ok = true;
  for (const key of Object.keys(provided)) {
    if (!declared.has(key)) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "template-arg-unknown",
          `inject of "${name}" passed unknown arg "${key}"`,
        ),
        sourcePathFor(ctx, step, stepPath, ["with", key]),
      );
      ok = false;
    }
  }
  const args: Record<string, TemplateArg> = {};
  for (const param of template.params) {
    const has = Object.hasOwn(provided, param.name);
    if (!has) {
      if (param.required) {
        pushDiagnostic(
          ctx,
          "error",
          diagnosticMessage(
            "template-arg-missing",
            `inject of "${name}" is missing required arg "${param.name}"`,
          ),
          sourcePathFor(ctx, step, stepPath, ["with"]),
        );
        ok = false;
        continue;
      }
      args[param.name] = { type: param.type, value: param.default };
      continue;
    }
    const value = provided[param.name];
    const typeOk =
      param.type === "enum"
        ? typeof value === "string" && (param.values?.includes(value) ?? false)
        : valueMatchesParamType(param.type, value);
    if (!typeOk) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "template-arg-type",
          `inject of "${name}" arg "${param.name}" does not match declared type "${param.type}"`,
        ),
        sourcePathFor(ctx, step, stepPath, ["with", param.name]),
      );
      ok = false;
      continue;
    }
    args[param.name] = { type: param.type, value };
  }
  return ok ? args : undefined;
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
  templates: TemplateMap,
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
      out.push(
        ...expandList(step as Step[], ctx, fragments, templates, stack, stepPath, depth + 1),
      );
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
      if (isCrossFileInject(name)) {
        pushDiagnostic(
          ctx,
          "error",
          diagnosticMessage(
            "inject-cross-file-unsupported",
            `cross-file inject "${name}" is not supported yet; the \`./lib#name\` selector lands with cross-file import support`,
          ),
          sourcePathFor(ctx, step, stepPath, ["inject"]),
        );
        continue;
      }
      const template = templates[name];
      if (template) {
        if (stack.includes(name)) {
          pushDiagnostic(
            ctx,
            "error",
            diagnosticMessage(
              "template-cycle",
              `template cycle detected: ${[...stack, name].join(" -> ")}`,
            ),
            sourcePathFor(ctx, step, stepPath, ["inject"]),
          );
          continue;
        }
        const args = validateTemplateArgs(ctx, name, template, step, stepPath);
        if (!args) continue;
        const body = template.steps.map((s) => cloneNode(ctx, s));
        resolveArgsInBody(ctx, body, args, stepPath ?? []);
        out.push(
          ...expandList(body, ctx, fragments, templates, [...stack, name], undefined, depth),
        );
        continue;
      }
      const extraKeys = Object.keys(step).filter((k) => k !== "inject");
      if (extraKeys.length > 0) {
        pushDiagnostic(
          ctx,
          "warning",
          `inject of "${name}" ignores extra keys (${extraKeys.join(", ")}); parameterized fragments are not supported yet`,
          sourcePathFor(ctx, step, stepPath, [extraKeys[0] ?? "inject"]),
        );
      }
      if (name in fragments) {
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
        out.push(
          ...expandList(copies, ctx, fragments, templates, [...stack, name], undefined, depth),
        );
        continue;
      }
      if ("with" in step) {
        pushDiagnostic(
          ctx,
          "error",
          diagnosticMessage("template-unknown", `Unknown template "${name}"`),
          sourcePathFor(ctx, step, stepPath, ["inject"]),
          {
            hint: `Define it under top-level "templates:" (available: ${
              Object.keys(templates).join(", ") || "none"
            })`,
          },
        );
        continue;
      }
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
    if (isObject(step) && step.fallback != null) {
      expandFallbackInPlace(
        step,
        ctx,
        fragments,
        templates,
        stack,
        sourcePathFor(ctx, step, stepPath),
      );
    }
    out.push(step);
  }
  return out;
}

/** Expand inject entries that live inside a step- or job-level `fallback` block. */
function expandFallbackInPlace(
  container: Step | Job,
  ctx: ParseContext,
  fragments: FragmentMap,
  templates: TemplateMap,
  stack: string[],
  containerPath?: Path,
): void {
  const fb = container.fallback;
  if (Array.isArray(fb)) {
    container.fallback = expandList(
      asFlattenableSteps(fb),
      ctx,
      fragments,
      templates,
      stack,
      containerPath ? [...containerPath, "fallback"] : undefined,
    );
  } else if (isObject(fb) && Array.isArray(fb.steps)) {
    fb.steps = expandList(
      asFlattenableSteps(fb.steps),
      ctx,
      fragments,
      templates,
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
  const templates = getTemplates(ctx);
  visitJobs(ctx, ({ id, job }) => {
    if (Array.isArray(job.steps)) {
      job.steps = expandList(job.steps, ctx, fragments, templates, [], ["jobs", id, "steps"]);
    }
    if (job.fallback != null) {
      expandFallbackInPlace(
        job,
        ctx,
        fragments,
        templates,
        [],
        sourcePathFor(ctx, job, ["jobs", id]),
      );
    }
    resolveCompileTimeTextBoundaries(ctx, job, ["jobs", id], {
      validateRuntimeExpressions: false,
      enforceNoResidualTokens: false,
      reportInterpolationErrors: false,
    });
    stripResidualWhenCompile(ctx, job, ["jobs", id]);
  });
  delete ctx.data.fragments;
  delete ctx.data.templates;
  delete ctx.data._anchors;
  stripResidualWhenCompile(ctx, ctx.data, []);
}

/** Splice reusable `inject:` steps in first, so later passes see real steps. */
export const fragments: Pass = {
  name: "fragments",
  runsAfter: ["params", "when-compile"],
  apply: fragmentsPass,
};

import { type Job, visitJobs, type Workflow, workflow } from "../ir.js";
import { KEY_ORDER, type ParseContext, setKeyOrder } from "../parser.js";
import { asArray, clone, combineIf, isObject, mergeNeeds, pushDiagnostic } from "./helpers.js";
import type { Pass } from "./registry.js";

/**
 * The keys a `call-templates:` entry may carry, i.e. the plumbing of a
 * reusable-workflow call job. Order here is the canonical fallback emit order;
 * a template's own authored order still wins (see `composeCallTemplate`).
 */
export const CALL_TEMPLATE_KEYS = ["uses", "with", "needs", "secrets", "if"] as const;

export type CallTemplateKey = (typeof CALL_TEMPLATE_KEYS)[number];

const CALL_TEMPLATE_KEY_SET = new Set<string>(CALL_TEMPLATE_KEYS);

type CallTemplate = Record<string, unknown>;

/** Read a node's effective key order: recorded author order, else insertion order. */
function readKeyOrder(obj: Record<string, unknown>): string[] {
  const recorded = (obj as Record<symbol, unknown>)[KEY_ORDER] as string[] | undefined;
  const present = Object.keys(obj);
  if (!recorded) return present;
  return [...recorded.filter((k) => k in obj), ...present.filter((k) => !recorded.includes(k))];
}

/** Shallow per-key object merge: base positions kept, `over` overrides in place, new keys append. */
function shallowMerge(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return clone(over);
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) out[k] = clone(v);
  return out;
}

/**
 * Merge one call-template key, `over` winning. Used for both the compose chain
 * (template-over-template) and the inline phase (job-over-template):
 * - `with`           shallow per-key override
 * - `secrets`        string on either side replaces; two maps shallow-merge
 * - `needs`          order-preserving union (array)
 * - `if`             combine with `&&`
 * - everything else  replace (`uses`)
 */
function mergeCallValue(key: string, base: unknown, over: unknown): unknown {
  if (over === undefined) return base === undefined ? undefined : clone(base);
  if (base === undefined) return clone(over);
  switch (key) {
    case "with":
      return shallowMerge(base, over);
    case "secrets":
      if (typeof base === "string" || typeof over === "string") return clone(over);
      return shallowMerge(base, over);
    case "needs":
      return mergeNeeds(base, asArray(over) as string[]);
    case "if":
      return combineIf(base as string, over as string);
    default:
      return clone(over);
  }
}

/** Fold `refs` left-to-right into one template, tracking author-defined key order. */
function composeCallTemplate(
  refs: string[],
  templates: Record<string, CallTemplate>,
): { composed: CallTemplate; order: string[] } {
  const composed: CallTemplate = {};
  const order: string[] = [];
  for (const ref of refs) {
    const tmpl = templates[ref];
    if (!tmpl) continue;
    for (const key of readKeyOrder(tmpl)) {
      if (!CALL_TEMPLATE_KEY_SET.has(key)) continue;
      composed[key] = mergeCallValue(key, composed[key], tmpl[key]);
      if (!order.includes(key)) order.push(key);
    }
  }
  return { composed, order };
}

/** Validate and normalize the top-level `call-templates:` map. */
function getCallTemplates(ctx: ParseContext): Record<string, CallTemplate> {
  const raw = (workflow(ctx) as Workflow)["call-templates"];
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    pushDiagnostic(ctx, "error", '"call-templates" must be a mapping', ["call-templates"], {
      code: "call-templates-must-be-mapping",
    });
    return {};
  }
  const out: Record<string, CallTemplate> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isObject(value)) {
      pushDiagnostic(
        ctx,
        "error",
        `Call template "${name}" must be a mapping`,
        ["call-templates", name],
        { code: "call-template-must-be-mapping" },
      );
      continue;
    }
    const tmpl: CallTemplate = {};
    for (const [key, field] of Object.entries(value)) {
      if (!CALL_TEMPLATE_KEY_SET.has(key)) {
        pushDiagnostic(
          ctx,
          "error",
          `[call-template-rejected-key] Key "${key}" is not allowed in a call template`,
          ["call-templates", name, key],
          { hint: `Allowed keys: ${CALL_TEMPLATE_KEYS.join(", ")}` },
        );
        continue;
      }
      tmpl[key] = field;
    }
    out[name] = tmpl;
  }
  return out;
}

/** Parse a job's `extends:` into a non-empty list of template refs. */
function parseExtendsRefs(
  ctx: ParseContext,
  jobId: string,
  rawExtends: unknown,
): string[] | undefined {
  if (typeof rawExtends === "string") {
    const ref = rawExtends.trim();
    if (ref.length > 0) return [ref];
    pushDiagnostic(ctx, "error", `Job "${jobId}": extends must be a non-empty string`, [
      "jobs",
      jobId,
      "extends",
    ]);
    return undefined;
  }

  if (!Array.isArray(rawExtends)) {
    pushDiagnostic(ctx, "error", `Job "${jobId}": extends must be a string or list of strings`, [
      "jobs",
      jobId,
      "extends",
    ]);
    return undefined;
  }

  const refs: string[] = [];
  let valid = true;
  rawExtends.forEach((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      valid = false;
      pushDiagnostic(ctx, "error", `Job "${jobId}": extends entries must be non-empty strings`, [
        "jobs",
        jobId,
        "extends",
        index,
      ]);
      return;
    }
    refs.push(value.trim());
  });
  if (valid && refs.length === 0) {
    pushDiagnostic(
      ctx,
      "warning",
      `[extends-empty] Job "${jobId}": extends list is empty; no call template will be applied`,
      ["jobs", jobId, "extends"],
    );
  }
  return valid ? refs : undefined;
}

/**
 * Resolve `extends:` on reusable-workflow call jobs into materialized plumbing.
 *
 * Runs before `job-defaults` so a job written as just `{ extends, with }` carries
 * a real `uses` before partitioning. Inline keys win over the template; a job
 * with inline `steps` or no resolved `uses` is rejected (call-job-only in v1).
 */
export function callTemplatesPass(ctx: ParseContext): void {
  const templates = getCallTemplates(ctx);

  visitJobs(ctx, ({ id, job }) => {
    const rawExtends = (job as Job).extends;
    if (rawExtends === undefined) return;

    const refs = parseExtendsRefs(ctx, id, rawExtends);
    if (!refs) {
      delete (job as Job).extends;
      return;
    }

    if (Array.isArray(job.steps)) {
      pushDiagnostic(
        ctx,
        "error",
        `[extends-on-noncall-job] Job "${id}": extends is only valid on reusable-workflow call jobs, but this job defines steps`,
        ["jobs", id, "extends"],
      );
      delete (job as Job).extends;
      return;
    }

    const missing = refs.filter((ref) => !templates[ref]);
    if (missing.length > 0) {
      const available = Object.keys(templates);
      for (const ref of missing) {
        pushDiagnostic(
          ctx,
          "error",
          `[call-template-unknown] Unknown call template "${ref}"`,
          ["jobs", id, "extends"],
          {
            hint:
              available.length > 0
                ? `Available templates: ${available.join(", ")}`
                : "No call-templates are defined",
          },
        );
      }
      delete (job as Job).extends;
      return;
    }

    const { composed, order } = composeCallTemplate(refs, templates);

    const inline: CallTemplate = {};
    for (const key of CALL_TEMPLATE_KEYS) {
      if (Object.hasOwn(job, key)) inline[key] = (job as Record<string, unknown>)[key];
    }

    for (const key of CALL_TEMPLATE_KEYS) {
      const merged = mergeCallValue(key, composed[key], inline[key]);
      if (merged !== undefined) (job as Record<string, unknown>)[key] = merged;
    }

    const existingOrder = readKeyOrder(job).filter((k) => k !== "extends");
    delete (job as Job).extends;

    if (!(typeof job.uses === "string" && job.uses.length > 0)) {
      pushDiagnostic(
        ctx,
        "error",
        `[extends-on-noncall-job] Job "${id}": no call template in the chain provides "uses" and the job sets none`,
        ["jobs", id],
      );
      return;
    }

    const templateSet = new Set(order);
    const inlineOnly = existingOrder.filter((k) => !templateSet.has(k));
    setKeyOrder(job, [...inlineOnly, ...order]);
  });

  delete (workflow(ctx) as Workflow)["call-templates"];
}

export const callTemplates: Pass = {
  name: "call-templates",
  runsAfter: ["params"],
  apply: callTemplatesPass,
};

import type { ParseContext, Path } from "../parser.js";
import { expectMapping, isObject, pushDiagnostic, warnUnknownKeys } from "./helpers.js";
import type { Pass } from "./registry.js";

// `reusable` lets an author declare a workflow as both callable (`workflow_call`)
// and dispatchable (`workflow_dispatch`) once. Actio emits both trigger blocks
// and normalizes input references to the single canonical runtime form
// `${{ inputs.x }}`, rewriting the dispatch-only footgun `github.event.inputs.x`
// (which is null under workflow_call) to it across the whole workflow body.

const ALLOWED_KEYS: ReadonlySet<string> = new Set(["inputs", "secrets", "outputs", "dispatch"]);

// workflow_call requires a type and only accepts this subset; it is also valid
// for workflow_dispatch, so a shared input maps cleanly onto both triggers.
const SHARED_INPUT_TYPES: ReadonlySet<string> = new Set(["string", "boolean", "number"]);

const isIdStart = (char: string): boolean => /[A-Za-z_]/.test(char);
const isIdPart = (char: string): boolean => /[A-Za-z0-9_]/.test(char);

const INPUTS_CHAIN = ".event.inputs";

/** Copy an input def for emission, defaulting `type` to the workflow_call-required `string`. */
const buildInput = (def: Record<string, unknown>): Record<string, unknown> => ({
  ...def,
  type: def.type ?? "string",
});

/**
 * Rewrite `${{ github.event.inputs.X }}` to `${{ inputs.X }}` (and the bare object
 * `github.event.inputs` to `inputs`) inside one text scalar. Quote-aware so dotted
 * chains inside GHA string literals are left alone; warns on names not declared
 * under `reusable.inputs`. A naive indexOf("}}") is unsound, so we walk the body.
 */
const rewriteText = (ctx: ParseContext, value: string, declared: ReadonlySet<string>): string => {
  if (!value.includes("${{")) return value;

  let out = "";
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("${{", cursor);
    if (open < 0) {
      out += value.slice(cursor);
      break;
    }
    out += value.slice(cursor, open);

    const bodyStart = open + 3;
    let i = bodyStart;
    let quote: "'" | '"' | undefined;
    let close = -1;
    let body = "";

    while (i < value.length) {
      const ch = value[i] ?? "";

      if (quote) {
        body += ch;
        if (ch === quote) {
          if (quote === "'" && value[i + 1] === "'") {
            body += "'";
            i += 2;
            continue;
          }
          if (quote === '"') {
            let backslashes = 0;
            let j = i - 1;
            while (j >= bodyStart && value[j] === "\\") {
              backslashes++;
              j--;
            }
            if (backslashes % 2 === 1) {
              i++;
              continue;
            }
          }
          quote = undefined;
        }
        i++;
        continue;
      }

      if (ch === "'" || ch === '"') {
        quote = ch;
        body += ch;
        i++;
        continue;
      }

      if (ch === "}" && value[i + 1] === "}") {
        close = i;
        break;
      }

      if (isIdStart(ch)) {
        let end = i + 1;
        while (end < value.length && isIdPart(value[end] ?? "")) end++;
        const ident = value.slice(i, end);

        if (ident === "github" && isRootReference(value, i, bodyStart)) {
          const consumed = matchInputsChain(value, end, ctx, declared);
          if (consumed) {
            body += consumed.replacement;
            i = consumed.next;
            continue;
          }
        }

        body += ident;
        i = end;
        continue;
      }

      body += ch;
      i++;
    }

    if (close < 0) {
      out += value.slice(open);
      break;
    }
    out += `\${{${body}}}`;
    cursor = close + 2;
  }
  return out;
};

/** True when the identifier at `idStart` is a context root (not preceded by `.`). */
const isRootReference = (value: string, idStart: number, bodyStart: number): boolean => {
  let prev = idStart - 1;
  while (prev >= bodyStart && /\s/.test(value[prev] ?? "")) prev--;
  return !(prev >= bodyStart && value[prev] === ".");
};

interface ChainMatch {
  replacement: string;
  next: number;
}

/** Match `.event.inputs(.name)?` starting at `from`; null when it is not our chain. */
const matchInputsChain = (
  value: string,
  from: number,
  ctx: ParseContext,
  declared: ReadonlySet<string>,
): ChainMatch | null => {
  if (!value.startsWith(INPUTS_CHAIN, from)) return null;
  const after = from + INPUTS_CHAIN.length;
  const tail = value[after];

  if (tail === ".") {
    const nameStart = after + 1;
    if (nameStart < value.length && isIdStart(value[nameStart] ?? "")) {
      let nameEnd = nameStart + 1;
      while (nameEnd < value.length && isIdPart(value[nameEnd] ?? "")) nameEnd++;
      const name = value.slice(nameStart, nameEnd);
      if (!declared.has(name)) {
        pushDiagnostic(
          ctx,
          "warning",
          `\`github.event.inputs.${name}\` references an input not declared under \`reusable.inputs\`; it is null under workflow_call.`,
          undefined,
          {
            code: "reusable-input-undeclared",
            hint: "Add it to reusable.inputs or remove the reference.",
          },
        );
      }
      return { replacement: `inputs.${name}`, next: nameEnd };
    }
    // Trailing dot with no identifier: rewrite the object and leave the dot in place.
    return { replacement: "inputs", next: after };
  }

  // `github.event.inputsX` is a different token, not the inputs object.
  if (tail !== undefined && isIdPart(tail)) return null;

  return { replacement: "inputs", next: after };
};

/** Recursively rewrite every text scalar in the value tree in place. */
const normalizeRefs = (node: unknown, ctx: ParseContext, declared: ReadonlySet<string>): void => {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const child = node[i];
      if (typeof child === "string") node[i] = rewriteText(ctx, child, declared);
      else normalizeRefs(child, ctx, declared);
    }
    return;
  }
  if (isObject(node)) {
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (typeof child === "string") node[key] = rewriteText(ctx, child, declared);
      else normalizeRefs(child, ctx, declared);
    }
  }
};

/** Coerce any `on:` shape into a mutable event-keyed object, preserving existing events. */
const toEventObject = (on: unknown): Record<string, unknown> => {
  if (isObject(on)) return on;
  if (typeof on === "string") return { [on]: null };
  if (Array.isArray(on)) {
    const obj: Record<string, unknown> = {};
    for (const event of on) if (typeof event === "string") obj[event] = null;
    return obj;
  }
  return {};
};

const reusablePass = (ctx: ParseContext): void => {
  const data = ctx.data as Record<string, unknown>;
  const block = data.reusable;
  if (block === undefined) return;

  const basePath: Path = ["reusable"];
  if (
    !expectMapping(ctx, block, basePath, {
      message: "`reusable` must be a mapping with optional inputs, secrets, outputs, and dispatch.",
      code: "reusable-shape",
    })
  ) {
    delete data.reusable;
    return;
  }

  warnUnknownKeys(ctx, block, ALLOWED_KEYS, basePath, {
    severity: "error",
    message: (key) =>
      `Unknown \`reusable\` key \`${key}\`. Allowed keys: inputs, secrets, outputs, dispatch.`,
    code: "reusable-unknown-key",
  });

  let dispatch = true;
  const dispatchRaw = block.dispatch;
  if (dispatchRaw !== undefined) {
    if (typeof dispatchRaw === "boolean") {
      dispatch = dispatchRaw;
    } else {
      pushDiagnostic(
        ctx,
        "error",
        "`reusable.dispatch` must be a boolean.",
        [...basePath, "dispatch"],
        {
          code: "reusable-dispatch-type",
        },
      );
    }
  }

  const declared = new Set<string>();
  const callInputs: Record<string, unknown> = {};
  const dispatchInputs: Record<string, unknown> = {};
  const rawInputs = block.inputs;
  if (
    rawInputs !== undefined &&
    expectMapping(ctx, rawInputs, [...basePath, "inputs"], {
      message: "`reusable.inputs` must be a mapping of input definitions.",
      code: "reusable-inputs-shape",
    })
  ) {
    for (const [name, def] of Object.entries(rawInputs)) {
      const defPath: Path = [...basePath, "inputs", name];
      if (
        !expectMapping(ctx, def, defPath, {
          message: `\`reusable.inputs.${name}\` must be a mapping.`,
          code: "reusable-input-shape",
        })
      ) {
        continue;
      }
      if (def.type !== undefined && !SHARED_INPUT_TYPES.has(def.type as string)) {
        pushDiagnostic(
          ctx,
          "error",
          `\`reusable.inputs.${name}.type\` must be string, boolean, or number.`,
          [...defPath, "type"],
          {
            code: "reusable-input-type",
            hint: "choice and environment are workflow_dispatch-only and cannot be shared with workflow_call.",
          },
        );
        continue;
      }
      declared.add(name);
      callInputs[name] = buildInput(def);
      dispatchInputs[name] = buildInput(def);
    }
  }

  const callBlock: Record<string, unknown> = {};
  if (Object.keys(callInputs).length > 0) callBlock.inputs = callInputs;
  for (const key of ["secrets", "outputs"] as const) {
    const raw = block[key];
    if (raw === undefined) continue;
    if (
      expectMapping(ctx, raw, [...basePath, key], {
        message: `\`reusable.${key}\` must be a mapping.`,
        code: `reusable-${key}-shape`,
      })
    ) {
      callBlock[key] = raw;
    }
  }

  const onObj = toEventObject(data.on);
  if ("workflow_call" in onObj || (dispatch && "workflow_dispatch" in onObj)) {
    pushDiagnostic(
      ctx,
      "error",
      "`reusable` cannot be combined with a hand-written `on.workflow_call` or `on.workflow_dispatch`.",
      ["on"],
      {
        code: "reusable-trigger-conflict",
        hint: "Remove the hand-written trigger and let `reusable` generate it, or drop the `reusable` block.",
      },
    );
    delete data.reusable;
    return;
  }

  onObj.workflow_call = Object.keys(callBlock).length > 0 ? callBlock : null;
  if (dispatch) {
    onObj.workflow_dispatch =
      Object.keys(dispatchInputs).length > 0 ? { inputs: dispatchInputs } : null;
  }
  data.on = onObj;
  delete data.reusable;

  normalizeRefs(data, ctx, declared);
};

export const reusable: Pass = { name: "reusable", runsAfter: ["params"], apply: reusablePass };

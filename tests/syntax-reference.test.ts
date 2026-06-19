import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { actioSchema } from "actio-core";
import { describe, expect, it } from "vitest";

/**
 * Drift check for the canonical syntax reference (`docs/content/docs/syntax.mdx`).
 *
 * The page is the "bible" for everything Actio adds on top of GitHub Actions, so it must
 * stay in lock-step with the real contract — `packages/core/schema/actio.schema.json`.
 * This test derives the set of Actio macro keywords (and, for option-bearing macros,
 * their option keys) straight from the schema, then asserts the docs cover exactly that
 * set. It intentionally diffs the keyword/option *inventory*, not prose wording.
 */

type Node = Record<string, unknown>;

const schema = actioSchema() as Node;
const defs = (schema.definitions ?? {}) as Node;

/** Resolve a `$ref` node to its definition (returns the node itself when not a ref). */
function resolveRef(node: unknown): Node | undefined {
  if (!node || typeof node !== "object") return undefined;
  const ref = (node as Node).$ref;
  if (typeof ref !== "string") return node as Node;
  return ref
    .split("/")
    .reduce<unknown>((acc, key) => (key === "#" ? schema : (acc as Node)?.[key]), schema) as
    | Node
    | undefined;
}

const MACRO_RE = /Actio macro/i;

/** True when a node is *itself* tagged as an Actio macro (title/description). */
function tagged(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as Node;
  return MACRO_RE.test([n.title, n.description, n.markdownDescription].filter(Boolean).join(" "));
}

/**
 * A property is an Actio macro if it is tagged inline OR its `$ref` target is tagged.
 * Both checks matter: some macros tag the property node (e.g. `job_defaults`), others
 * only tag the shared definition the property `$ref`s into (e.g. `dynamic_matrix`).
 */
function isMacro(node: unknown): boolean {
  return tagged(node) || tagged(resolveRef(node));
}

/** Collect Actio macro keys from a container's `properties` + `static_if(<expr>)` pattern. */
function collectMacros(container: unknown): Set<string> {
  const out = new Set<string>();
  const c = (container ?? {}) as Node;
  for (const [key, value] of Object.entries((c.properties ?? {}) as Node)) {
    if (isMacro(value)) out.add(key);
  }
  for (const key of Object.keys((c.patternProperties ?? {}) as Node)) {
    if (/static_if/.test(key)) out.add("static_if()");
  }
  return out;
}

// Macros can live at the workflow root, on a job (`normalJob`), or on a step (`step`).
const schemaMacros = new Set<string>([
  ...collectMacros(schema),
  ...collectMacros(defs.normalJob),
  ...collectMacros(defs.step),
]);

/**
 * Macros that ship as compiler passes but are not (yet) in the JSON Schema. `for_each`
 * runs before validation and `step` is `additionalProperties: false`, so it cannot be
 * schema-tagged today. Documented deliberately; allow-listed here so parity still holds.
 * If one of these ever lands in the schema, the guard test below flags it for removal.
 */
const KNOWN_SCHEMA_GAPS = new Set<string>(["for_each"]);

const canonicalMacros = new Set<string>([...schemaMacros, ...KNOWN_SCHEMA_GAPS]);

const SYNTAX = readFileSync(
  fileURLToPath(new URL("../docs/content/docs/syntax.mdx", import.meta.url)),
  "utf8",
);

// Each documented keyword carries a `{/* macro:<keyword> */}` marker above its heading.
const documentedMacros = new Set<string>(
  [...SYNTAX.matchAll(/\{\/\*\s*macro:(.+?)\s*\*\/\}/g)].map((m) => m[1].trim()),
);

const sorted = (set: Iterable<string>): string[] => [...set].sort();
const missingFrom = (expected: Set<string>, actual: Set<string>): string[] =>
  sorted(expected).filter((k) => !actual.has(k));

describe("syntax reference ↔ schema drift", () => {
  it("documents every Actio macro keyword", () => {
    expect(missingFrom(canonicalMacros, documentedMacros)).toEqual([]);
  });

  it("documents no keywords that are not Actio macros", () => {
    expect(missingFrom(documentedMacros, canonicalMacros)).toEqual([]);
  });

  it("keeps the schema-gap allow-list honest", () => {
    // When a gap macro finally lands in the schema, drop it from KNOWN_SCHEMA_GAPS.
    expect([...KNOWN_SCHEMA_GAPS].filter((k) => schemaMacros.has(k))).toEqual([]);
  });
});

/** Option-bearing macros → the schema definition whose property keys they expose. */
const OPTION_DEFS: Record<string, string> = {
  params: "actioParam",
  job_defaults: "jobDefaults",
  executors: "executorDefinition",
  finally: "finallyBlock",
  dynamic_matrix: "dynamicMatrix",
  retry: "retry",
  fallback: "fallback",
  share: "sharedOutput",
};

/** Union of `properties` keys across a definition's `oneOf` arms (or the def itself). */
function schemaOptionKeys(defName: string): Set<string> {
  const def = (defs[defName] ?? {}) as Node;
  const arms = (Array.isArray(def.oneOf) ? def.oneOf : [def]) as unknown[];
  const out = new Set<string>();
  for (const arm of arms) {
    const resolved = resolveRef(arm);
    for (const key of Object.keys((resolved?.properties ?? {}) as Node)) out.add(key);
  }
  return out;
}

/** Top-level keys of the `<TypeTable type={{ ... }}>` that follows a macro's marker. */
function typeTableKeys(macro: string): Set<string> | undefined {
  const marker = `{/* macro:${macro} */}`;
  const start = SYNTAX.indexOf(marker);
  if (start < 0) return undefined;
  const next = SYNTAX.indexOf("{/* macro:", start + marker.length);
  const body = SYNTAX.slice(start, next < 0 ? undefined : next);

  const tableAt = body.indexOf("type={{");
  if (tableAt < 0) return undefined;

  // Walk the object literal, collecting only depth-1 text (skips nested option bodies).
  let depth = 0;
  let topLevel = "";
  for (let i = tableAt + "type={".length; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) topLevel += ch;
  }

  const keys = new Set<string>();
  for (const m of topLevel.matchAll(/(?:'([^']+)'|([A-Za-z_$][\w-]*))\s*:/g)) {
    keys.add(m[1] ?? m[2]);
  }
  return keys;
}

describe("syntax reference option tables ↔ schema", () => {
  it("has exactly one option table per option-bearing macro", () => {
    const tableCount = (SYNTAX.match(/<TypeTable/g) ?? []).length;
    expect(tableCount).toBe(Object.keys(OPTION_DEFS).length);
  });

  for (const [macro, defName] of Object.entries(OPTION_DEFS)) {
    it(`option table for \`${macro}\` matches \`${defName}\``, () => {
      const documented = typeTableKeys(macro);
      expect(documented, `no <TypeTable> found for ${macro}`).toBeDefined();
      const expected = schemaOptionKeys(defName);
      expect(sorted(documented ?? new Set())).toEqual(sorted(expected));
    });
  }
});

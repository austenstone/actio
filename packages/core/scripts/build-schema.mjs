// Generates packages/core/schema/actio.schema.json by merging the Actio macro
// layer (actio.extensions.json) onto the vendored official GitHub Actions
// workflow schema (vendor/github-workflow.json). Run via `npm run schema:build`.
//
// Why merge instead of `allOf`-referencing the upstream schema: the GitHub
// Actions schema sets `additionalProperties: false` on the root, jobs, and
// steps, so a referenced/intersected schema would reject every Actio macro key.
// Merging the macro keys directly into those `properties` maps lets us inherit
// the entire official surface (events, runners, contexts, validation) while
// keeping strict typo-checking AND allowing the macros exactly where valid.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const schemaDir = new URL("../schema/", import.meta.url);
const read = (rel) => JSON.parse(readFileSync(new URL(rel, schemaDir), "utf8"));

export function buildSchema() {
  const upstream = read("vendor/github-workflow.json");
  const ext = read("actio.extensions.json");
  const s = structuredClone(upstream);

  s.$schema = upstream.$schema ?? "http://json-schema.org/draft-07/schema#";
  Object.assign(s, ext.meta);
  s.$comment =
    "GENERATED FILE — do not edit by hand. Built by scripts/build-schema.mjs from " +
    "vendor/github-workflow.json (the official GitHub Actions schema from SchemaStore) " +
    "plus actio.extensions.json (the Actio macro layer). Edit actio.extensions.json and " +
    "run `npm run schema:build -w actio-core`. Refresh the upstream snapshot with " +
    "`npm run schema:refresh -w actio-core`.";

  s.properties = { ...s.properties, ...ext.rootProperties };

  for (const [def, patch] of Object.entries(ext.patchDefinitions)) {
    const target = s.definitions[def];
    if (!target) throw new Error(`upstream schema is missing definition "${def}"`);
    if (patch.properties) target.properties = { ...target.properties, ...patch.properties };
    if (patch.appendOneOf) target.oneOf = [...(target.oneOf ?? []), ...patch.appendOneOf];
  }

  s.definitions = { ...s.definitions, ...ext.addDefinitions };

  const out = fileURLToPath(new URL("actio.schema.json", schemaDir));
  writeFileSync(out, `${JSON.stringify(s, null, 2)}\n`, "utf8");
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = buildSchema();
  process.stderr.write(`\u2713 wrote ${out}\n`);
}

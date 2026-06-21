#!/usr/bin/env node
// Scaffold a macro doc page so a new built-in pass can clear the docs-completeness
// guardrail (tests/docs-completeness.test.ts) without hand-copying an existing page.
// Usage: npm run docs:new <keyword>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const macrosDir = join(repoRoot, "docs/content/docs/macros");
const schemaPath = join(repoRoot, "packages/core/schema/actio.extensions.json");

// The `when-compile` pass ships to users as the `static-if` keyword/slug; mirror the
// same alias the guardrail test uses so scaffolding by pass name lands the right file.
const slugAlias = { "when-compile": "static-if" };

const keyword = process.argv[2];
if (!keyword) {
  console.error("usage: npm run docs:new <keyword>");
  console.error("  e.g. npm run docs:new retry");
  process.exit(1);
}

const slug = slugAlias[keyword] ?? keyword;
const outPath = join(macrosDir, `${slug}.mdx`);

if (existsSync(outPath)) {
  console.error(`refusing to overwrite existing page: docs/content/docs/macros/${slug}.mdx`);
  process.exit(1);
}

const camel = (value) => value.replace(/[-_](.)/g, (_, char) => char.toUpperCase());

const resolveRef = (ref, schema) => {
  const match = /^#\/definitions\/(.+)$/.exec(ref ?? "");
  if (!match) return null;
  const name = match[1];
  return schema.addDefinitions?.[name] ?? schema.patchDefinitions?.[name] ?? null;
};

const describeType = (node) => {
  if (!node || typeof node !== "object") return "unknown";
  if (typeof node.type === "string") return node.type;
  if (Array.isArray(node.type)) return node.type.join(" | ");
  if (node.$ref) return node.$ref.split("/").pop();
  for (const key of ["oneOf", "anyOf"]) {
    if (Array.isArray(node[key])) {
      const types = node[key].map(describeType).filter((value) => value !== "unknown");
      if (types.length) return [...new Set(types)].join(" | ");
    }
  }
  return "unknown";
};

// Best-effort: walk a schema node (following $ref, oneOf/anyOf/allOf, and map-shaped
// additionalProperties) and collect documented property keys with type + description.
const collectProps = (node, schema, acc = {}, depth = 0) => {
  if (!node || typeof node !== "object" || depth > 5) return acc;
  if (node.$ref) return collectProps(resolveRef(node.$ref, schema), schema, acc, depth + 1);
  if (node.properties && typeof node.properties === "object") {
    for (const [key, value] of Object.entries(node.properties)) {
      if (!(key in acc))
        acc[key] = { type: describeType(value), description: value?.description ?? "" };
    }
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(node[key]))
      for (const branch of node[key]) collectProps(branch, schema, acc, depth + 1);
  }
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    collectProps(node.additionalProperties, schema, acc, depth + 1);
  }
  return acc;
};

const resolveSchemaProps = () => {
  let schema;
  try {
    schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  } catch {
    return {};
  }
  const variants = [keyword, keyword.replace(/-/g, "_"), keyword.replace(/_/g, "-")];
  const candidates = [
    schema.addDefinitions?.[camel(keyword)],
    schema.rootProperties?.[keyword],
    ...variants.map((name) => schema.patchDefinitions?.step?.properties?.[name]),
  ];
  const acc = {};
  for (const candidate of candidates) collectProps(candidate, schema, acc);
  return acc;
};

const buildTypeTable = () => {
  const props = resolveSchemaProps();
  const entries = Object.entries(props);
  const rows = entries.length
    ? entries
    : [
        [
          "TODO",
          {
            type: "unknown",
            description: `Document the options for \`${keyword}\` (see packages/core/schema/actio.extensions.json).`,
          },
        ],
      ];
  const body = rows
    .map(([key, info]) => {
      const safeKey = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      return `    ${safeKey}: { type: ${JSON.stringify(info.type)}, description: ${JSON.stringify(info.description)} },`;
    })
    .join("\n");
  return { table: `<TypeTable\n  type={{\n${body}\n  }}\n/>`, resolved: entries.length };
};

const { table, resolved } = buildTypeTable();

const page = `---
title: ${keyword}
description: TODO — one-line description of what \`${keyword}\` does (shown in the macro index).
---

TODO — one or two sentences on the chore \`${keyword}\` removes and how you reach for it.
Mirror the tone of the existing macro pages (share, soft_fail): lead with the problem,
then the macro that collapses it.

## Before / after compile

{/* TODO: replace BOTH blocks with REAL emitted output (see "next steps" below). */}

<CodeCompare>

\`\`\`yaml title=".actio.yml"
name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "TODO: minimal example that uses ${keyword}"
\`\`\`

\`\`\`yaml title="generated .yml"
# TODO: paste the compiled output here.
\`\`\`

</CodeCompare>

## Options

${
  resolved
    ? "{/* Auto-generated from packages/core/schema/actio.extensions.json — review types and prose. */}"
    : "{/* TODO: schema lookup failed — fill in the real options below. */}"
}

${table}

## Gotchas

<Callout title="TODO">
  TODO — call out the surprising edge case (a compile error, a runtime caveat, an
  interaction with another macro). Delete this Callout if there is nothing to warn about.
</Callout>

See the [syntax reference](/docs/syntax) for the full \`${keyword}\` option list.
`;

writeFileSync(outPath, page);

console.log(`created docs/content/docs/macros/${slug}.mdx`);
console.log("");
console.log("next steps:");
console.log(`  1. Add "${slug}" to docs/content/docs/macros/meta.json so it shows in the sidebar.`);
console.log("  2. Replace the YAML placeholders with REAL emitted output:");
console.log(
  "       node packages/cli/dist/cli.js build --stdout <sample.actio.yml> --no-pin --no-header --no-source-map --no-annotate",
);
console.log(
  "  3. Fill in the TODO frontmatter, intro, and Gotchas, then run `npm run docs:build`.",
);
if (!resolved) {
  console.log(
    "  note: could not resolve options from the schema — the TypeTable is a TODO stub you must complete.",
  );
}

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Build the Actio JSON Schema by inheriting GitHub's official workflow schema
 * and layering the Actio macros on top: extend `step`/`normalJob`/root with the
 * macro keywords and allow an `inject`-only step past the upstream `oneOf` gate.
 */
export function buildActioSchema() {
  const base = JSON.parse(readFileSync(here("./github-workflow.json"), "utf8"));
  const overlay = JSON.parse(readFileSync(here("./actio-macros.json"), "utf8"));

  Object.assign(base, overlay.meta);
  Object.assign(base.definitions, overlay.definitions);
  Object.assign(base.properties, overlay.rootProperties);
  Object.assign(base.definitions.step.properties, overlay.stepProperties);
  base.definitions.step.oneOf.push(overlay.stepOneOf);
  Object.assign(base.definitions.normalJob.properties, overlay.jobProperties);

  return base;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(here("./actio.schema.json"), `${JSON.stringify(buildActioSchema(), null, 2)}\n`);
  process.stderr.write("wrote packages/core/schema/actio.schema.json\n");
}

// Refreshes the vendored official GitHub Actions workflow schema from
// SchemaStore, then regenerates actio.schema.json. Run when GitHub adds new
// workflow features. Usage: `npm run schema:refresh -w actio-core`.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSchema } from "./build-schema.mjs";

const UPSTREAM_URL = "https://json.schemastore.org/github-workflow.json";

const res = await fetch(UPSTREAM_URL);
if (!res.ok) throw new Error(`failed to fetch ${UPSTREAM_URL}: ${res.status} ${res.statusText}`);

// Reformat to 2-space JSON so vendor diffs are reviewable.
const upstream = JSON.stringify(await res.json(), null, 2);
const vendorPath = fileURLToPath(new URL("../schema/vendor/github-workflow.json", import.meta.url));
writeFileSync(vendorPath, `${upstream}\n`, "utf8");
process.stderr.write(`\u2713 updated ${vendorPath}\n`);

const out = buildSchema();
process.stderr.write(`\u2713 wrote ${out}\n`);

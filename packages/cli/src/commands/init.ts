import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import pc from "picocolors";
import { STARTER_ACTIO } from "../starter.js";

const ACTIO_SUFFIX = ".actio.yml";
const DEFAULT_NAME = "ci";
const YAML_SUFFIX_RE = /(\.actio)?\.ya?ml$/i;

// Accept whatever the user hands us (`ci`, `ci.yml`, `ci.yaml`, `ci.actio.yaml`,
// `path/to/ci.actio.yml`) and normalize it to the `.actio.yml` source suffix
// that `build` discovers via `**/*.actio.yml`.
export function normalizeInitTarget(file?: string): string {
  const raw = (file ?? DEFAULT_NAME).trim() || DEFAULT_NAME;
  const stem = raw.replace(YAML_SUFFIX_RE, "");
  return `${stem}${ACTIO_SUFFIX}`;
}

export async function runInit(file?: string): Promise<number> {
  const target = normalizeInitTarget(file);
  if (existsSync(target)) {
    process.stderr.write(`${pc.yellow("warning")}: ${target} already exists; not overwriting\n`);
    return 1;
  }
  await writeFile(target, STARTER_ACTIO, "utf8");
  process.stderr.write(`${pc.green("✓")} created ${target}\n`);
  return 0;
}

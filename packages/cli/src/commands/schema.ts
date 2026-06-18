import { writeFile } from "node:fs/promises";
import { actioSchemaJson } from "actio-core";
import pc from "picocolors";

export async function runSchema(out?: string): Promise<number> {
  const json = `${actioSchemaJson().trimEnd()}\n`;
  if (out) {
    await writeFile(out, json, "utf8");
    process.stderr.write(`${pc.green("✓")} wrote schema to ${out}\n`);
    return 0;
  }
  process.stdout.write(json);
  return 0;
}

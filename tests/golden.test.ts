import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transpile } from "@actio/core";
import { describe, expect, it } from "vitest";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixtureNames(): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

describe("golden fixtures", () => {
  for (const name of fixtureNames()) {
    it(`transpiles ${name} to its expected output`, () => {
      const input = readFileSync(join(fixturesDir, name, "input.actio"), "utf8");
      const expected = readFileSync(join(fixturesDir, name, "expected.yml"), "utf8");
      const result = transpile(input, { fileName: "input.actio" });

      // Every fixture must produce a schema-valid workflow with no errors.
      const errors = result.diagnostics.filter((d) => d.severity === "error");
      expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.yaml).toBe(expected);
    });
  }
});

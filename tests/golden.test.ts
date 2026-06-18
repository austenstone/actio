import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type TranspileOptions, transpile } from "actio-core";
import { describe, expect, it } from "vitest";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixtureNames(): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

interface GoldenFixtureOptions
  extends Pick<TranspileOptions, "validate" | "target" | "nativeDependencies"> {}

function fixtureOptions(name: string): GoldenFixtureOptions {
  const optionsPath = join(fixturesDir, name, "options.json");
  if (!existsSync(optionsPath)) return {};
  const parsed = JSON.parse(readFileSync(optionsPath, "utf8")) as GoldenFixtureOptions;
  return parsed;
}

describe("golden fixtures", () => {
  for (const name of fixtureNames()) {
    it(`transpiles ${name} to its expected output`, () => {
      const input = readFileSync(join(fixturesDir, name, "input.actio.yml"), "utf8");
      const expected = readFileSync(join(fixturesDir, name, "expected.yml"), "utf8");
      const result = transpile(input, { fileName: "input.actio.yml", ...fixtureOptions(name) });

      // Every fixture must produce a schema-valid workflow with no errors.
      const errors = result.diagnostics.filter((d) => d.severity === "error");
      expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.yaml).toBe(expected);
    });
  }
});

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type ModuleResolver, type TranspileOptions, transpile } from "actio-core";
import { describe, expect, it } from "vitest";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixtureNames(): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

interface GoldenFixtureOptions
  extends Pick<TranspileOptions, "validate" | "target" | "nativeDependencies" | "permissions"> {}

function fixtureOptions(name: string): GoldenFixtureOptions {
  const optionsPath = join(fixturesDir, name, "options.json");
  if (!existsSync(optionsPath)) return {};
  const parsed = JSON.parse(readFileSync(optionsPath, "utf8")) as GoldenFixtureOptions;
  return parsed;
}

// Cross-file fixtures keep their imported modules as sibling *.actio.yml files
// next to input.actio.yml. When any exist, expose them through an in-memory
// resolver so the golden run stays string->string pure (no fs access in core).
function fixtureModules(name: string): ModuleResolver | undefined {
  const baseDir = join(fixturesDir, name);
  const hasModules = readdirSync(baseDir).some(
    (f) => f.endsWith(".actio.yml") && f !== "input.actio.yml",
  );
  if (!hasModules) return undefined;
  return {
    resolve(spec, fromFile) {
      const target = join(baseDir, dirname(fromFile), spec);
      if (!existsSync(target) || !statSync(target).isFile()) return undefined;
      return { id: relative(baseDir, target), source: readFileSync(target, "utf8") };
    },
  };
}

describe("golden fixtures", () => {
  for (const name of fixtureNames()) {
    it(`transpiles ${name} to its expected output`, () => {
      const input = readFileSync(join(fixturesDir, name, "input.actio.yml"), "utf8");
      const expected = readFileSync(join(fixturesDir, name, "expected.yml"), "utf8");
      const result = transpile(input, {
        fileName: "input.actio.yml",
        modules: fixtureModules(name),
        ...fixtureOptions(name),
      });

      // Every fixture must produce a schema-valid workflow with no errors.
      const errors = result.diagnostics.filter((d) => d.severity === "error");
      expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.yaml).toBe(expected);
    });
  }
});

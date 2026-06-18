import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinPasses } from "actio-core";
import { describe, expect, it } from "vitest";

const fixturesDir = fileURLToPath(new URL("fixtures", import.meta.url));

const fixtureDirsByPassName: Record<string, string[]> = {
  dynamic_matrix: ["dynamic-matrix"],
  fallback: ["fallback-job", "fallback-notify", "fallback-recover"],
  fragments: ["fragments"],
  retry: ["retry-basic", "retry-delay", "retry-shorthand"],
};

const hasGoldenPair = (fixtureDir: string): boolean =>
  existsSync(join(fixturesDir, fixtureDir, "input.actio.yml")) &&
  existsSync(join(fixturesDir, fixtureDir, "expected.yml"));

describe("pass fixture completeness", () => {
  it("requires every built-in pass to have at least one golden fixture", () => {
    const missing = builtinPasses
      .map((pass) => ({
        pass: pass.name,
        fixtures: fixtureDirsByPassName[pass.name] ?? [pass.name],
      }))
      .filter(({ fixtures }) => !fixtures.some(hasGoldenPair));

    expect(missing).toEqual([]);
  });
});

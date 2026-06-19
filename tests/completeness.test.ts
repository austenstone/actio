import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinPasses } from "actio-core";
import { describe, expect, it } from "vitest";

const fixturesDir = fileURLToPath(new URL("fixtures", import.meta.url));

const fixtureDirsByPassName: Record<string, string[]> = {
  dynamic_matrix: ["dynamic-matrix"],
  if_changed: ["if-changed-step", "if-changed-job", "if-changed-dedup", "if-changed-pr-base"],
  "injection-hoist": ["injection-hoist"],
  fallback: ["fallback-job", "fallback-notify", "fallback-recover"],
  fragments: ["fragments"],
  lifecycle: [
    "bare-finally",
    "ensure-job",
    "ensure-step",
    "finally-auto-needs-all-real-jobs",
    "finally-on-abort-empty",
    "finally-on-abort-replace",
    "finally-outcome-branches",
    "finally-when-sugar",
  ],
  params: ["params-scalar", "params-list", "params-step-list", "params-enum"],
  job_defaults: [
    "job-defaults-normal-merge",
    "job-defaults-uses-partition",
    "job-defaults-if-combine",
    "job-defaults-shape-aware",
    "executors-expansion",
    "executors-compose",
  ],
  retry: ["retry-basic", "retry-delay", "retry-shorthand"],
  share: [
    "share-simple-single",
    "share-same-job",
    "share-multiline",
    "share-json-fanout",
    "share-required",
    "share-escape",
  ],
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

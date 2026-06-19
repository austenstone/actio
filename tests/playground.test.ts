import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { sampleSource } from "../docs/components/playground/sample";

interface ParsedWorkflow {
  jobs: Record<string, Record<string, unknown>>;
}

describe("playground sample", () => {
  it("compiles without diagnostics while keeping call jobs separate from executor defaults", () => {
    const result = transpile(sampleSource, {
      fileName: "docs/components/playground/sample.ts",
      sourceMap: true,
    });
    const doc = parse(result.yaml) as ParsedWorkflow;

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(doc.jobs.plan["runs-on"]).toBe("ubuntu-latest");
    expect(doc.jobs.plan.env).toEqual({
      CHANNEL: "canary",
      CI: "true",
      NODE_ENV: "test",
    });
    expect(doc.jobs["reusable-unit"].uses).toBe("./.github/workflows/check.yml");
    expect(doc.jobs["reusable-unit"]["runs-on"]).toBeUndefined();
    expect(doc.jobs["reusable-unit"].env).toBeUndefined();
    expect(doc.jobs["reusable-unit"].permissions).toEqual({ contents: "read" });
  });
});

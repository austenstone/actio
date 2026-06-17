import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transpile } from "@actio/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** The `everything` fixture exercises every macro in a single workflow. These
 * assertions prove the passes compose — fragments feed retry/fallback, and
 * dynamic_matrix rewrites a job that also carries an inject + job-level fallback. */
describe("all features together (everything fixture)", () => {
  const src = readFileSync(join(fixturesDir, "everything", "input.actio.yml"), "utf8");
  const result = transpile(src, { fileName: "input.actio.yml", sourceMap: true });
  // biome-ignore lint/suspicious/noExplicitAny: parsed workflow is dynamic
  const doc = parse(result.yaml) as any;

  it("transpiles with no errors", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("expands fragments in every job that injects them", () => {
    expect(doc.fragments).toBeUndefined();
    expect(doc.jobs.lint.steps[0]).toEqual({ uses: "actions/checkout@v4" });
    expect(doc.jobs.test.steps[0]).toEqual({ uses: "actions/checkout@v4" });
    expect(doc.jobs.test.steps[1].uses).toBe("actions/setup-node@v4");
  });

  it("fans retry into guarded attempts with backoff between them", () => {
    const ids = doc.jobs.lint.steps.map((s: { id?: string }) => s.id).filter(Boolean);
    expect(ids).toContain("step_install_attempt_1");
    expect(ids).toContain("step_install_attempt_3");
    const backoff = doc.jobs.lint.steps.find((s: { run?: string }) => s.run === "sleep 5");
    expect(backoff.if).toBe("steps.step_install_attempt_1.outcome == 'failure'");
  });

  it("wires step-level recover fallback", () => {
    const lint = doc.jobs.lint.steps.find((s: { name?: string }) => s.name === "Lint");
    expect(lint["continue-on-error"]).toBe(true);
    const recover = doc.jobs.lint.steps.find(
      (s: { run?: string }) => s.run === 'echo "lint failed, continuing"',
    );
    expect(recover.if).toBe("steps.step_lint.outcome == 'failure'");
  });

  it("appends job-level notify fallback gated on failure()", () => {
    const report = doc.jobs.test.steps.find((s: { name?: string }) => s.name === "Report failure");
    expect(report.if).toBe("failure()");
    expect(doc.jobs.test.fallback).toBeUndefined();
  });

  it("builds the dynamic_matrix setup job and rewires the consumer", () => {
    expect(doc.jobs.actio_setup_test).toBeDefined();
    expect(doc.jobs.test.needs).toEqual(["actio_setup_test"]);
    expect(doc.jobs.test.strategy.matrix.shard).toBe(
      "${{ fromJSON(needs.actio_setup_test.outputs.matrix) }}",
    );
    expect(doc.jobs.test.strategy["fail-fast"]).toBe(false);
  });

  it("produces a source map that points generated lines back at the source", () => {
    expect(result.map).toBeDefined();
    expect(result.map?.mappings.length ?? 0).toBeGreaterThan(0);
  });
});

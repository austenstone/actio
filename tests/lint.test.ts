import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ActionlintRun,
  type ActionlintRunner,
  defaultActionlintRunner,
  lintWorkflowYaml,
  type SpawnSync,
  transpile,
} from "actio-core";
import { describe, expect, it } from "vitest";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name, "input.actio.yml"), "utf8");
}

function genLineOf(yaml: string, needle: string): number {
  const idx = yaml.split("\n").findIndex((l) => l.includes(needle));
  if (idx === -1) throw new Error(`generated line not found: ${needle}`);
  return idx + 1;
}

const VALID = `name: Valid
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

/** Records the YAML it was handed and returns a fixed run. */
function stubRunner(run: ActionlintRun): ActionlintRunner & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((yaml: string) => {
    calls.push(yaml);
    return run;
  }) as ActionlintRunner & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** Emits a finding pinned to whichever generated line contains `needle`. */
function findingAt(needle: string, kind?: string): ActionlintRunner {
  return (yaml) => ({
    available: true,
    findings: [{ message: `flag ${needle}`, line: genLineOf(yaml, needle), column: 9, kind }],
  });
}

describe("lintWorkflowYaml", () => {
  it("skips entirely when mode is off", () => {
    const runner = stubRunner({ available: true, findings: [] });
    expect(lintWorkflowYaml(VALID, "v.actio.yml", "off", runner)).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  });

  it("emits a single info note when the binary is unavailable", () => {
    const out = lintWorkflowYaml(VALID, "v.actio.yml", "error", () => ({
      available: false,
      findings: [],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      severity: "info",
      source: "actio",
      code: "actionlint-unavailable",
      file: "v.actio.yml",
    });
    expect(out[0].range).toBeUndefined();
  });

  it("emits a warning note when actionlint ran but failed", () => {
    const out = lintWorkflowYaml(VALID, "v.actio.yml", "error", () => ({
      available: true,
      findings: [],
      error: "unparseable output",
    }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "warning", code: "actionlint-failed" });
    expect(out[0].message).toContain("unparseable output");
  });

  it("maps findings to error severity in error mode", () => {
    const out = lintWorkflowYaml(VALID, "v.actio.yml", "error", () => ({
      available: true,
      findings: [{ message: "bad needs", line: 5, column: 3, end_column: 12, kind: "job-needs" }],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      severity: "error",
      source: "actionlint",
      code: "actionlint-job-needs",
      range: { start: { line: 5, col: 3 }, end: { line: 5, col: 12 } },
    });
  });

  it("maps findings to warning severity in warn mode", () => {
    const out = lintWorkflowYaml(VALID, "v.actio.yml", "warn", () => ({
      available: true,
      findings: [{ message: "bad", line: 2, column: 1 }],
    }));
    expect(out[0].severity).toBe("warning");
    expect(out[0].code).toBe("actionlint");
    expect(out[0].range).toMatchObject({ start: { line: 2, col: 1 }, end: { line: 2, col: 1 } });
  });
});

describe("defaultActionlintRunner", () => {
  function spy(res: { stdout?: string | null; error?: Error }): SpawnSync {
    return () => res;
  }

  it("treats ENOENT as an absent binary", () => {
    const err = Object.assign(new Error("spawn actionlint ENOENT"), { code: "ENOENT" });
    expect(defaultActionlintRunner("yaml", spy({ error: err }))).toEqual({
      available: false,
      findings: [],
    });
  });

  it("reports a non-ENOENT spawn error as available-but-failed", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const run = defaultActionlintRunner("yaml", spy({ error: err }));
    expect(run).toMatchObject({ available: true, findings: [] });
    expect(run.error).toContain("permission denied");
  });

  it("returns no findings for empty/whitespace output", () => {
    expect(defaultActionlintRunner("yaml", spy({ stdout: "   \n" }))).toEqual({
      available: true,
      findings: [],
    });
    expect(defaultActionlintRunner("yaml", spy({ stdout: null }))).toEqual({
      available: true,
      findings: [],
    });
  });

  it("parses a JSON findings array", () => {
    const json = JSON.stringify([{ message: "x", line: 3, column: 2, kind: "syntax-check" }]);
    const run = defaultActionlintRunner("yaml", spy({ stdout: json }));
    expect(run.available).toBe(true);
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]).toMatchObject({ message: "x", line: 3, kind: "syntax-check" });
  });

  it("flags unparseable stdout instead of throwing", () => {
    const run = defaultActionlintRunner("yaml", spy({ stdout: "not json" }));
    expect(run).toMatchObject({ available: true, findings: [] });
    expect(run.error).toBe("actionlint produced unparseable output");
  });
});

describe("transpile output linting", () => {
  it("never invokes the runner when lint is off (default)", () => {
    const runner = stubRunner({ available: true, findings: [] });
    const result = transpile(VALID, {
      fileName: "v.actio.yml",
      validate: false,
      actionlintRunner: runner,
    });
    expect(runner.calls).toHaveLength(0);
    expect(result.diagnostics.filter((d) => d.source === "actionlint")).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("emits a warning and stays green in warn mode", () => {
    const result = transpile(VALID, {
      fileName: "v.actio.yml",
      validate: false,
      lint: "warn",
      actionlintRunner: () => ({
        available: true,
        findings: [{ message: "flagged", line: 1, column: 1, kind: "syntax-check" }],
      }),
    });
    const lint = result.diagnostics.filter((d) => d.source === "actionlint");
    expect(lint).toHaveLength(1);
    expect(lint[0].severity).toBe("warning");
    expect(result.ok).toBe(true);
  });

  it("fails the build in error mode", () => {
    const result = transpile(VALID, {
      fileName: "v.actio.yml",
      validate: false,
      lint: "error",
      actionlintRunner: () => ({
        available: true,
        findings: [{ message: "flagged", line: 1, column: 1, kind: "syntax-check" }],
      }),
    });
    const lint = result.diagnostics.filter((d) => d.source === "actionlint");
    expect(lint[0].severity).toBe("error");
    expect(result.ok).toBe(false);
  });

  it("produces no diagnostics for a clean lint run", () => {
    const result = transpile(VALID, {
      fileName: "v.actio.yml",
      validate: false,
      lint: "error",
      actionlintRunner: () => ({ available: true, findings: [] }),
    });
    expect(result.diagnostics.filter((d) => d.source === "actionlint")).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("skips gracefully when actionlint is absent while schema still runs", () => {
    const schemaInvalid = [
      "name: Bad",
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - frobnicate: yes",
      "",
    ].join("\n");
    const result = transpile(schemaInvalid, {
      fileName: "bad.actio.yml",
      lint: "error",
      actionlintRunner: () => ({ available: false, findings: [] }),
    });
    const note = result.diagnostics.find((d) => d.code === "actionlint-unavailable");
    expect(note?.severity).toBe("info");
    expect(result.diagnostics.some((d) => d.source === "schema" && d.range)).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("remaps a finding's generated line back to its source position", () => {
    const result = transpile(fixture("fragments"), {
      fileName: "input.actio.yml",
      validate: false,
      sourceMap: true,
      lint: "error",
      actionlintRunner: findingAt("actions/setup-node@v4", "pin"),
    });
    const lint = result.diagnostics.filter((d) => d.source === "actionlint");
    expect(lint).toHaveLength(1);
    expect(lint[0].code).toBe("actionlint-pin");
    expect(lint[0].range?.start.line).toBe(6);
  });

  it("leaves the finding on the generated line without a source map", () => {
    const src = fixture("fragments");
    const { yaml } = transpile(src, { fileName: "input.actio.yml", validate: false });
    const genLine = genLineOf(yaml, "actions/setup-node@v4");
    const result = transpile(src, {
      fileName: "input.actio.yml",
      validate: false,
      lint: "error",
      actionlintRunner: findingAt("actions/setup-node@v4", "pin"),
    });
    const lint = result.diagnostics.find((d) => d.source === "actionlint");
    expect(lint?.range?.start.line).toBe(genLine);
    expect(genLine).not.toBe(6);
  });
});

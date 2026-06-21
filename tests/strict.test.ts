import { type Diagnostic, transpile } from "actio-core";
import { describe, expect, it } from "vitest";

const compile = (source: string, strict?: boolean) =>
  transpile(source, { fileName: "t.actio.yml", validate: false, strict });

const mergeKeys = (diagnostics: Diagnostic[]) =>
  diagnostics.filter((d) => d.code === "yaml-merge-key");

const lineOf = (source: string, needle: string) =>
  source.split("\n").findIndex((l) => l.includes(needle)) + 1;

const singleMerge = `name: T
on: [push]
x-anchors:
  base: &base
    FOO: bar
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      <<: *base
      BAZ: qux
    steps:
      - run: echo hi
`;

describe("strict 1.2.2 merge-key lint", () => {
  it("flags a block-map merge key under strict mode", () => {
    const diagnostics = mergeKeys(compile(singleMerge, true).diagnostics);
    expect(diagnostics).toHaveLength(1);
    const diag = diagnostics[0];
    expect(diag.code).toBe("yaml-merge-key");
    expect(diag.severity).toBe("warning");
    expect(diag.source).toBe("actio");
    expect(diag.message).toContain("1.1 merge key");
    expect(diag.range?.start.line).toBe(lineOf(singleMerge, "<<: *base"));
  });

  it("does not flag merge keys when strict mode is off (default)", () => {
    expect(mergeKeys(compile(singleMerge).diagnostics)).toHaveLength(0);
    expect(mergeKeys(compile(singleMerge, false).diagnostics)).toHaveLength(0);
  });

  it("keeps emitted YAML byte-identical with and without strict mode", () => {
    const off = compile(singleMerge, false);
    const on = compile(singleMerge, true);
    expect(on.yaml).toBe(off.yaml);
  });

  it("is non-fatal: strict findings are warnings, so the result stays ok", () => {
    const result = compile(singleMerge, true);
    expect(result.ok).toBe(true);
  });

  it("emits one diagnostic per merge-key usage", () => {
    const source = `name: T
on: [push]
x-anchors:
  base: &base
    FOO: bar
jobs:
  a:
    runs-on: ubuntu-latest
    env:
      <<: *base
    steps:
      - run: echo a
  b:
    runs-on: ubuntu-latest
    env:
      <<: *base
    steps:
      - run: echo b
`;
    expect(mergeKeys(compile(source, true).diagnostics)).toHaveLength(2);
  });

  it("never flags anchors or aliases that omit the merge key", () => {
    const source = `name: T
on: [push]
x-anchors:
  step: &step
    run: echo hi
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - *step
`;
    expect(mergeKeys(compile(source, true).diagnostics)).toHaveLength(0);
  });

  it("never flags a stray << that is not in key position", () => {
    const source = `name: T
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    env:
      marker: <<
      quoted: "<<"
    steps:
      - run: echo "<<: not a merge"
`;
    expect(mergeKeys(compile(source, true).diagnostics)).toHaveLength(0);
  });
});

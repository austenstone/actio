import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml" });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  return { result, errors, doc: result.ok ? parse(result.yaml) : undefined };
}

function codes(result: { diagnostics: { code?: string; severity: string }[] }): string[] {
  return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code ?? "");
}

describe("matrix comprehension", () => {
  it("expands [expr for x in list] to a native matrix.include with no setup job", () => {
    const { result, errors, doc } = build(`name: M
on: [push]
params:
  versions:
    type: object
    default: [18, 20]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: "{{ [ { node: v } for v in params.versions ] }}"
    steps:
      - run: echo hi
`);
    expect(errors).toEqual([]);
    const matrix = doc.jobs.test.strategy.matrix;
    expect(matrix).toEqual({ include: [{ node: 18 }, { node: 20 }] });
    // No dynamic-matrix machinery survives: no setup job, no fromJSON.
    expect(Object.keys(doc.jobs)).toEqual(["test"]);
    expect(result.yaml).not.toContain("fromJSON");
    expect(result.yaml).not.toContain("actio-matrix");
  });

  it("reads compile-time let constants and stdlib inside the comprehension body", () => {
    const { errors, doc } = build(`name: M
on: [push]
let:
  prefix: node
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: "{{ [ { tag: format('{0}-{1}', let.prefix, v) } for v in [1, 2] ] }}"
    steps:
      - run: echo hi
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.test.strategy.matrix).toEqual({
      include: [{ tag: "node-1" }, { tag: "node-2" }],
    });
  });

  it("preserves ${{ }} runtime expressions verbatim in matrix-driven steps", () => {
    const { result } = build(`name: M
on: [push]
params:
  versions:
    type: object
    default: [18]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: "{{ [ { node: v } for v in params.versions ] }}"
    steps:
      - run: echo "\${{ matrix.node }}"
`);
    expect(result.yaml).toContain('echo "${{ matrix.node }}"');
  });

  it("leaves a static literal matrix untouched", () => {
    const { errors, doc } = build(`name: M
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - run: echo hi
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.test.strategy.matrix).toEqual({ node: [18, 20] });
  });

  it("errors expr-type-error when the comprehension iterates a non-list", () => {
    const { result } = build(`name: M
on: [push]
params:
  value:
    type: number
    default: 5
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: "{{ [ { n: x } for x in params.value ] }}"
    steps:
      - run: echo hi
`);
    expect(codes(result)).toContain("expr-type-error");
  });
});

describe("compile-time token guardrail", () => {
  it("reports uses-unresolved when a {{ }} token survives into a uses: position", () => {
    const { result } = build(`name: M
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: "actions/checkout@{{ params.missing }}"
`);
    expect(codes(result)).toContain("uses-unresolved");
  });

  it("reports expr-stray when a {{ }} token survives into a non-uses position", () => {
    const { result } = build(`name: M
on: [push]
defaults:
  run:
    shell: "{{ params.missing }}"
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(codes(result)).toContain("expr-stray");
  });

  it("does not flag native ${{ }} runtime expressions in run/if/env", () => {
    const { result, errors } = build(`name: M
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    if: \${{ github.ref == 'refs/heads/main' }}
    env:
      TOKEN: \${{ secrets.TOKEN }}
    steps:
      - run: echo "\${{ github.sha }}"
`);
    expect(errors).toEqual([]);
    expect(codes(result)).not.toContain("expr-stray");
    expect(codes(result)).not.toContain("uses-unresolved");
    expect(result.yaml).toContain("${{ github.ref == 'refs/heads/main' }}");
    expect(result.yaml).toContain("${{ secrets.TOKEN }}");
    expect(result.yaml).toContain('echo "${{ github.sha }}"');
  });
});

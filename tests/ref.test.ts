import { type TranspileOptions, transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { detectCycle, topoOrder } from "../packages/core/src/passes/referenceGraph.js";

function build(source: string, options?: Partial<TranspileOptions>) {
  const result = transpile(source, { fileName: "t.actio.yml", ...options });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  return { result, errors, warnings, doc: result.ok ? parse(result.yaml) : undefined };
}

function codesOf(result: { diagnostics: { code?: string }[] }): string[] {
  return result.diagnostics
    .map((d) => d.code)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
}

const hasCode = (result: { diagnostics: { code?: string }[] }, code: string): boolean =>
  codesOf(result).includes(code);

function jobsOf(doc: { jobs?: Record<string, unknown> }): Record<string, Record<string, unknown>> {
  return (doc?.jobs ?? {}) as Record<string, Record<string, unknown>>;
}

const steps = (job: Record<string, unknown>): Array<Record<string, unknown>> =>
  (job?.steps ?? []) as Array<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Acceptance: same-job stays local, cross-job auto-wires needs + outputs
// ---------------------------------------------------------------------------

describe("ref: same-job resolution", () => {
  const SRC = `
name: SameJob
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Tag
        run: echo "tag=$(date +%s)" >> "$GITHUB_OUTPUT"
        ref:
          handle: tag
          outputs: [tag]
      - run: echo "building \${{ ref.tag.tag }}"
`;

  it("resolves to steps.<id>.outputs.<name> with no needs or outputs added", () => {
    const { errors, doc } = build(SRC);
    expect(errors).toEqual([]);
    const job = jobsOf(doc).build;
    expect(job.needs).toBeUndefined();
    expect(job.outputs).toBeUndefined();
    const producer = steps(job)[0];
    const consumer = steps(job)[1];
    expect(typeof producer.id).toBe("string");
    expect(consumer.run).toBe(`echo "building \${{ steps.${producer.id}.outputs.tag }}"`);
    expect(producer.ref).toBeUndefined();
  });
});

describe("ref: cross-job resolution", () => {
  const SRC = `
name: CrossJob
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        ref:
          handle: node
          outputs: [node-version]
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "on \${{ ref.node.node-version }}"
      - run: echo "again \${{ ref.node.node-version }}"
`;

  it("wires needs.<job>.outputs.<name>, auto needs, and synth outputs once", () => {
    const { errors, doc } = build(SRC);
    expect(errors).toEqual([]);
    const jobs = jobsOf(doc);
    const setup = jobs.setup;
    const build_ = jobs.build;
    const producer = steps(setup)[0];
    expect(setup.outputs).toEqual({
      "node-version": `\${{ steps.${producer.id}.outputs.node-version }}`,
    });
    expect(build_.needs).toEqual(["setup"]);
    for (const s of steps(build_)) {
      expect(String(s.run)).toContain("${{ needs.setup.outputs.node-version }}");
    }
  });

  it("dedups synth outputs across many consumers (no duplicate outputs map)", () => {
    const { doc } = build(SRC);
    const setup = jobsOf(doc).setup;
    expect(Object.keys(setup.outputs as Record<string, unknown>)).toEqual(["node-version"]);
  });
});

// ---------------------------------------------------------------------------
// Handles: explicit, derive-from-name, derive-from-id, collision
// ---------------------------------------------------------------------------

describe("ref: handle resolution", () => {
  it("derives the handle from the step name when none is given", () => {
    const { errors, doc } = build(`
name: Derive
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: Build Tag
        run: echo "v=1" >> "$GITHUB_OUTPUT"
        ref:
          outputs: [v]
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.build_tag.v }}"
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).b.needs).toEqual(["a"]);
  });

  it("falls back to the step id when there is no name or handle", () => {
    const { errors, doc } = build(`
name: DeriveId
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: tagger
        run: echo "v=1" >> "$GITHUB_OUTPUT"
        ref:
          outputs: [v]
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.tagger.v }}"
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).b.needs).toEqual(["a"]);
  });

  it("errors on a derive collision instead of silently picking", () => {
    const { result } = build(`
name: Collide
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: Tag
        run: echo "v=1" >> "$GITHUB_OUTPUT"
        ref:
          outputs: [v]
      - name: Tag
        run: echo "w=2" >> "$GITHUB_OUTPUT"
        ref:
          outputs: [w]
`);
    expect(hasCode(result, "ref-ambiguous")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-minted producers: action, hand-written run, reusable call-job
// ---------------------------------------------------------------------------

describe("ref: non-minted producers", () => {
  it("references a reusable call-job output with only a needs edge", () => {
    const { errors, doc } = build(`
name: CallJob
on: [push]
jobs:
  lib:
    uses: ./.github/workflows/lib.yml
  app:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.job.lib.version }}"
`);
    expect(errors).toEqual([]);
    const app = jobsOf(doc).app;
    expect(app.needs).toEqual(["lib"]);
    expect(String(steps(app)[0].run)).toContain("${{ needs.lib.outputs.version }}");
    expect(jobsOf(doc).lib.outputs).toBeUndefined();
  });

  it("lowers a dotted ref field to fromJSON", () => {
    const { errors, doc } = build(`
name: Dotted
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "meta=$X" >> "$GITHUB_OUTPUT"
        ref:
          handle: meta
          outputs: [meta]
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.meta.meta.sha }}"
`);
    expect(errors).toEqual([]);
    expect(String(steps(jobsOf(doc).b)[0].run)).toContain("fromJSON(needs.a.outputs.meta).sha");
  });
});

// ---------------------------------------------------------------------------
// Diagnostics: all 8 ref-* codes fire on their case
// ---------------------------------------------------------------------------

describe("ref: diagnostics", () => {
  it("ref-unknown-step: handle matches no producer", () => {
    const { result } = build(`
name: D
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.nope.v }}"
`);
    expect(hasCode(result, "ref-unknown-step")).toBe(true);
  });

  it("ref-unknown-output: run producer missing the output", () => {
    const { result } = build(`
name: D
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "v=1" >> "$GITHUB_OUTPUT"
        ref:
          handle: h
          outputs: [v]
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.h.missing }}"
`);
    expect(hasCode(result, "ref-unknown-output")).toBe(true);
  });

  it("ref-ambiguous: same handle across two jobs, referenced unqualified", () => {
    const { result, doc } = build(`
name: D
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "v=1" >> "$GITHUB_OUTPUT"
        ref:
          handle: dup
          outputs: [v]
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "w=2" >> "$GITHUB_OUTPUT"
        ref:
          handle: dup
          outputs: [w]
  c:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.dup.v }}"
`);
    expect(doc).toBeUndefined();
    expect(hasCode(result, "ref-ambiguous")).toBe(true);
  });

  it("ref-ambiguous: a cross-job handle is reachable when qualified", () => {
    const { errors, doc } = build(`
name: D
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "v=1" >> "$GITHUB_OUTPUT"
        ref:
          handle: dup
          outputs: [v]
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "w=2" >> "$GITHUB_OUTPUT"
        ref:
          handle: dup
          outputs: [w]
  c:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.a.dup.v }}"
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).c.needs).toEqual(["a"]);
  });

  it("ref-cycle: mutual cross-job references form a needs cycle", () => {
    const { result } = build(`
name: D
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "av=1" >> "$GITHUB_OUTPUT"
        ref:
          handle: ah
          outputs: [av]
      - run: echo "\${{ ref.bh.bv }}"
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "bv=2" >> "$GITHUB_OUTPUT"
        ref:
          handle: bh
          outputs: [bv]
      - run: echo "\${{ ref.ah.av }}"
`);
    expect(hasCode(result, "ref-cycle")).toBe(true);
  });

  it("ref-self: a step references its own handle", () => {
    const { result } = build(`
name: D
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "loop \${{ ref.me.v }}"
        ref:
          handle: me
          outputs: [v]
`);
    expect(hasCode(result, "ref-self")).toBe(true);
  });

  it("ref-output-undeclared: a ref producer without outputs", () => {
    const { result } = build(`
name: D
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        ref:
          handle: h
`);
    expect(hasCode(result, "ref-output-undeclared")).toBe(true);
  });

  it("ref-matrix-clobber: cross-job ref to a matrix producer", () => {
    const { result } = build(`
name: D
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux, mac]
    steps:
      - run: echo "v=1" >> "$GITHUB_OUTPUT"
        ref:
          handle: h
          outputs: [v]
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.h.v }}"
`);
    expect(hasCode(result, "ref-matrix-clobber")).toBe(true);
  });

  it("native matrix same-job ref stays local with no clobber", () => {
    const { errors, doc } = build(`
name: D
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux, mac]
    steps:
      - run: echo "v=1" >> "$GITHUB_OUTPUT"
        ref:
          handle: h
          outputs: [v]
      - run: echo "\${{ ref.h.v }}"
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).a.outputs).toBeUndefined();
    expect(String(steps(jobsOf(doc).a)[1].run)).toContain("steps.");
  });

  it("ref-output-unknown-on-action: warns but still wires an action output", () => {
    const { result, errors, doc } = build(`
name: D
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        ref:
          handle: node
          outputs: [node-version]
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.node.undeclared }}"
`);
    expect(errors).toEqual([]);
    expect(hasCode(result, "ref-output-unknown-on-action")).toBe(true);
    expect(String(steps(jobsOf(doc).b)[0].run)).toContain("${{ needs.a.outputs.undeclared }}");
  });
});

// ---------------------------------------------------------------------------
// Idempotency and share coexistence
// ---------------------------------------------------------------------------

describe("ref: idempotency", () => {
  it("transpiles byte-identically twice", () => {
    const src = `
name: Idem
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        ref:
          handle: node
          outputs: [node-version]
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.node.node-version }}"
`;
    const a = transpile(src, { fileName: "t.actio.yml" });
    const b = transpile(src, { fileName: "t.actio.yml" });
    expect(a.yaml).toBe(b.yaml);
    expect(a.ok).toBe(true);
  });

  it("ref and share wire side by side in one workflow", () => {
    const { errors, doc } = build(`
name: Mixed
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "VERSION=1"
        share:
          version: $VERSION
      - uses: actions/setup-node@v4
        ref:
          handle: node
          outputs: [node-version]
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.version }} on \${{ ref.node.node-version }}"
`);
    expect(errors).toEqual([]);
    const run = String(steps(jobsOf(doc).b)[0].run);
    expect(run).toContain("${{ needs.a.outputs.version }}");
    expect(run).toContain("${{ needs.a.outputs.node-version }}");
    expect(jobsOf(doc).b.needs).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// Graph primitives (direct unit coverage of the shared engine)
// ---------------------------------------------------------------------------

describe("graph primitives", () => {
  it("detectCycle returns null on a DAG", () => {
    const adj = new Map<string, string[]>([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", []],
    ]);
    expect(detectCycle(adj)).toBeNull();
  });

  it("detectCycle returns the path on a cycle", () => {
    const adj = new Map<string, string[]>([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    const cycle = detectCycle(adj);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("a");
    expect(cycle).toContain("b");
  });

  it("topoOrder returns a valid linearization of a DAG", () => {
    const adj = new Map<string, string[]>([
      ["a", ["b", "c"]],
      ["b", ["c"]],
      ["c", []],
    ]);
    const order = topoOrder(adj);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  it("topoOrder drops nodes trapped in a cycle", () => {
    const adj = new Map<string, string[]>([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", []],
    ]);
    expect(topoOrder(adj)).toEqual(["c"]);
  });
});

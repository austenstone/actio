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

// ---------------------------------------------------------------------------
// Positional shorthand: ref: [outputs] is the primary producer form and is a
// pure alias for ref: { outputs: [..] }. The handle still derives from the
// step name then id, and explicit handle: (map form) still wins.
// ---------------------------------------------------------------------------

describe("ref: positional array shorthand", () => {
  it("emits byte-identical YAML to the equivalent { outputs } map form", () => {
    const arr = `
name: Shorthand
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        name: node
        ref: [node-version, dist-tag]
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.node.node-version }} \${{ ref.node.dist-tag }}"
`;
    const map = arr.replace(
      "ref: [node-version, dist-tag]",
      "ref: { outputs: [node-version, dist-tag] }",
    );
    const a = transpile(arr, { fileName: "t.actio.yml" });
    const m = transpile(map, { fileName: "t.actio.yml" });
    expect(a.ok).toBe(true);
    expect(m.ok).toBe(true);
    expect(a.yaml).toBe(m.yaml);
  });

  it("derives the handle from the step name for the array form", () => {
    const { errors, doc } = build(`
name: DeriveArr
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: Build Tag
        run: echo "v=1" >> "$GITHUB_OUTPUT"
        ref: [v]
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.build_tag.v }}"
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).b.needs).toEqual(["a"]);
  });

  it("falls back to the step id when the array form has no name or handle", () => {
    const { errors, doc } = build(`
name: DeriveArrId
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: tagger
        run: echo "v=1" >> "$GITHUB_OUTPUT"
        ref: [v]
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.tagger.v }}"
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).b.needs).toEqual(["a"]);
  });

  it("ref-output-undeclared: an empty array still errors", () => {
    const { result } = build(`
name: EmptyArr
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        ref: []
`);
    expect(hasCode(result, "ref-output-undeclared")).toBe(true);
  });

  it("explicit handle: in the map form still works and still wins over the name", () => {
    const { errors, doc } = build(`
name: HandleWins
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: Setup Node
        uses: actions/setup-node@v4
        ref: { handle: node, outputs: [node-version] }
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.node.node-version }}"
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).b.needs).toEqual(["a"]);
  });

  it("a cross-job array-form ref synthesizes job.outputs and merged needs", () => {
    const { errors, doc } = build(`
name: CrossArr
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        name: node
        ref: [node-version]
  build:
    needs: [lint]
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.node.node-version }}"
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`);
    expect(errors).toEqual([]);
    const setup = jobsOf(doc).setup;
    expect(setup.outputs).toEqual({
      "node-version": "${{ steps.step_node.outputs.node-version }}",
    });
    expect(jobsOf(doc).build.needs).toEqual(["lint", "setup"]);
  });
});

// ---------------------------------------------------------------------------
// Inference: ref: is optional. A step becomes a producer the moment a consumer
// references ref.<handle>.<output> and the handle matches its id or name.
// Omitting ref: must emit byte-identical YAML to the explicit ref: form.
// ---------------------------------------------------------------------------

describe("ref: inferred producers (no ref:)", () => {
  it("action producer: omitting ref: is byte-identical to ref: [outputs]", () => {
    const inferred = `
name: P
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        name: node
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.node.node-version }}"
`;
    const explicit = inferred.replace("name: node\n", "name: node\n        ref: [node-version]\n");
    const a = transpile(inferred, { fileName: "t.actio.yml" });
    const b = transpile(explicit, { fileName: "t.actio.yml" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.yaml).toBe(b.yaml);
  });

  it("run producer: omitting ref: with an echo $GITHUB_OUTPUT write is byte-identical", () => {
    const inferred = `
name: P
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - name: tag
        run: echo "version=1" >> "$GITHUB_OUTPUT"
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.tag.version }}"
`;
    const explicit = inferred.replace(
      '>> "$GITHUB_OUTPUT"\n',
      '>> "$GITHUB_OUTPUT"\n        ref: [version]\n',
    );
    const a = transpile(inferred, { fileName: "t.actio.yml" });
    const b = transpile(explicit, { fileName: "t.actio.yml" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.yaml).toBe(b.yaml);
    expect(a.diagnostics).toEqual([]);
  });

  it("same-job inference resolves to steps.<id>.outputs.<name> with no needs", () => {
    const { errors, doc } = build(`
name: SameJobInfer
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: tag
        run: echo "version=1" >> "$GITHUB_OUTPUT"
      - run: echo "\${{ ref.tag.version }}"
`);
    expect(errors).toEqual([]);
    const job = jobsOf(doc).build;
    expect(job.needs).toBeUndefined();
    expect(job.outputs).toBeUndefined();
    const producer = steps(job)[0];
    expect(steps(job)[1].run).toBe(`echo "\${{ steps.${producer.id}.outputs.version }}"`);
  });

  it("infers a producer from a step id when there is no name", () => {
    const { errors, doc } = build(`
name: InferById
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: tagger
        run: echo "v=1" >> "$GITHUB_OUTPUT"
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.tagger.v }}"
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).b.needs).toEqual(["a"]);
    expect(jobsOf(doc).a.outputs).toEqual({
      v: "${{ steps.tagger.outputs.v }}",
    });
  });

  it("hard errors when an inferred run producer never writes the referenced output", () => {
    const { result, errors } = build(`
name: Unwritten
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - name: tag
        run: echo "version=1" >> "$GITHUB_OUTPUT"
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.tag.missing }}"
`);
    expect(hasCode(result, "ref-output-unwritten")).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(result.ok).toBe(false);
  });

  it("degrades to a warning and wires anyway when a run write is dynamic", () => {
    const { result, errors, doc } = build(`
name: Dynamic
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - name: tag
        run: echo "$DYNAMIC" >> "$GITHUB_OUTPUT"
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.tag.version }}"
`);
    expect(errors).toEqual([]);
    expect(hasCode(result, "ref-output-unscannable")).toBe(true);
    expect(jobsOf(doc).build.needs).toEqual(["setup"]);
    expect(jobsOf(doc).setup.outputs).toEqual({
      version: "${{ steps.step_tag.outputs.version }}",
    });
  });

  it("warns at most once per dynamic producer across many references", () => {
    const { result } = build(`
name: DynamicOnce
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - name: tag
        run: echo "$DYNAMIC" >> "$GITHUB_OUTPUT"
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.tag.a }} \${{ ref.tag.b }} \${{ ref.tag.c }}"
`);
    const count = result.diagnostics.filter((d) => d.code === "ref-output-unscannable").length;
    expect(count).toBe(1);
  });

  it("an ambiguous inferred handle errors; the qualified form resolves it", () => {
    const ambiguous = `
name: Ambiguous
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        name: node
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        name: node
  c:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.node.node-version }}"
`;
    const r1 = build(ambiguous);
    expect(hasCode(r1.result, "ref-ambiguous")).toBe(true);

    const qualified = ambiguous.replace("ref.node.node-version", "ref.a.node.node-version");
    const r2 = build(qualified);
    expect(r2.errors).toEqual([]);
    expect(jobsOf(r2.doc).c.needs).toEqual(["a"]);
  });

  it("flags a self-reference even when the producer is inferred by name", () => {
    const { result } = build(`
name: SelfInfer
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: tag
        run: echo "version=\${{ ref.tag.version }}" >> "$GITHUB_OUTPUT"
`);
    expect(hasCode(result, "ref-self")).toBe(true);
  });

  it("scans heredoc and printf $GITHUB_OUTPUT writes as static", () => {
    const heredoc = build(`
name: Heredoc
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: tag
        run: |
          echo "notes<<EOF" >> "$GITHUB_OUTPUT"
          echo "line one" >> "$GITHUB_OUTPUT"
          echo "EOF" >> "$GITHUB_OUTPUT"
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.tag.notes }}"
`);
    expect(heredoc.errors).toEqual([]);
    expect(hasCode(heredoc.result, "ref-output-unscannable")).toBe(false);
    expect(jobsOf(heredoc.doc).b.needs).toEqual(["a"]);

    const printf = build(`
name: Printf
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: tag
        run: printf "version=1\\n" >> "$GITHUB_OUTPUT"
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.tag.version }}"
`);
    expect(printf.errors).toEqual([]);
    expect(hasCode(printf.result, "ref-output-unscannable")).toBe(false);
    expect(jobsOf(printf.doc).b.needs).toEqual(["a"]);
  });

  it("does not synthesize producers for unreferenced named steps", () => {
    const { errors, doc } = build(`
name: NoBulk
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: tag
        run: echo "version=1" >> "$GITHUB_OUTPUT"
      - name: other
        run: echo hi
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ ref.tag.version }}"
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).b.needs).toEqual(["a"]);
    expect(steps(jobsOf(doc).a)[1].id).toBeUndefined();
  });
});

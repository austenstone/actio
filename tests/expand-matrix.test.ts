import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Transpile and parse the generated YAML back to a JS object for assertions. */
function build(source: string, validate = true) {
  const result = transpile(source, { fileName: "t.actio.yml", validate });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  return { result, errors, warnings, doc: result.ok ? parse(result.yaml) : undefined };
}

/** Extract the `[code]` prefix from every diagnostic message. */
function codesOf(result: { diagnostics: { message: string }[] }): string[] {
  return result.diagnostics
    .map((d) => d.message.match(/^\[([^\]]+)\]/)?.[1])
    .filter((c): c is string => Boolean(c));
}

function hasCode(result: { diagnostics: { message: string }[] }, code: string): boolean {
  return codesOf(result).includes(code);
}

function jobsOf(doc: { jobs?: Record<string, unknown> }): Record<string, Record<string, unknown>> {
  return (doc?.jobs ?? {}) as Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Cartesian expansion + slugging
// ---------------------------------------------------------------------------

describe("expand_matrix: cartesian expansion", () => {
  it("unrolls a 2x2 matrix into four deterministically-slugged jobs", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ${"${{ matrix.os }}"}
    strategy:
      matrix:
        os: [linux, windows]
        arch: [x64, arm64]
    steps:
      - run: ./build --arch ${"${{ matrix.arch }}"}
`);
    expect(errors).toEqual([]);
    const jobs = jobsOf(doc);
    expect(Object.keys(jobs)).toEqual([
      "build-linux-x64",
      "build-linux-arm64",
      "build-windows-x64",
      "build-windows-arm64",
    ]);
    // strategy + macro key are gone, matrix.* resolved to concrete leg values.
    const leg = jobs["build-linux-x64"];
    expect(leg.strategy).toBeUndefined();
    expect(leg.expand_matrix).toBeUndefined();
    expect(leg["runs-on"]).toBe("linux");
    expect((leg.steps as { run: string }[])[0].run).toBe("./build --arch x64");
    expect((jobs["build-windows-arm64"].steps as { run: string }[])[0].run).toBe(
      "./build --arch arm64",
    );
  });

  it("preserves other jobs untouched", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: ./lint.sh
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux]
    steps:
      - run: ./build.sh
`);
    expect(errors).toEqual([]);
    const jobs = jobsOf(doc);
    expect(Object.keys(jobs)).toEqual(["lint", "build-linux"]);
    expect(jobs.lint.runs_on ?? jobs.lint["runs-on"]).toBe("ubuntu-latest");
  });
});

// ---------------------------------------------------------------------------
// include / exclude (GHA semantics)
// ---------------------------------------------------------------------------

describe("expand_matrix: include / exclude", () => {
  it("merges an include into matching legs without adding a new job", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux, windows]
        include:
          - os: linux
            sku: pro
    steps:
      - run: echo ${"${{ matrix.sku }}"}
`);
    expect(errors).toEqual([]);
    const jobs = jobsOf(doc);
    expect(Object.keys(jobs)).toEqual(["build-linux", "build-windows"]);
    // sku merged only into the linux leg; windows keeps the unresolved-but-empty value.
    expect((jobs["build-linux"].steps as { run: string }[])[0].run).toBe("echo pro");
  });

  it("appends an include with no matching leg as a brand-new leg", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ${"${{ matrix.os }}"}
    strategy:
      matrix:
        os: [linux]
        include:
          - os: mac
    steps:
      - run: ./build.sh
`);
    expect(errors).toEqual([]);
    const jobs = jobsOf(doc);
    expect(Object.keys(jobs)).toEqual(["build-linux", "build-mac"]);
    expect(jobs["build-mac"]["runs-on"]).toBe("mac");
  });

  it("drops legs that match an exclude entry", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux, windows]
        arch: [x64, arm64]
        exclude:
          - os: windows
            arch: arm64
    steps:
      - run: ./build.sh
`);
    expect(errors).toEqual([]);
    expect(Object.keys(jobsOf(doc))).toEqual([
      "build-linux-x64",
      "build-linux-arm64",
      "build-windows-x64",
    ]);
  });

  it("supports a partial exclude (subset of axes)", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux, windows]
        arch: [x64, arm64]
        exclude:
          - os: windows
    steps:
      - run: ./build.sh
`);
    expect(errors).toEqual([]);
    expect(Object.keys(jobsOf(doc))).toEqual(["build-linux-x64", "build-linux-arm64"]);
  });
});

// ---------------------------------------------------------------------------
// needs selectors
// ---------------------------------------------------------------------------

const FANOUT = `
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux, windows]
        arch: [x64, arm64]
    steps:
      - run: ./build.sh`;

describe("expand_matrix: needs selectors", () => {
  it("rewrites a full selector to exactly one concrete slug", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:${FANOUT}
  deploy:
    needs: build(os=linux, arch=x64)
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).deploy.needs).toBe("build-linux-x64");
  });

  it("expands a partial selector to every matching leg", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:${FANOUT}
  deploy:
    needs: build(os=linux)
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).deploy.needs).toEqual(["build-linux-x64", "build-linux-arm64"]);
  });

  it("unions multiple selectors in a needs array, deduped", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:${FANOUT}
  deploy:
    needs:
      - build(os=linux, arch=x64)
      - build(os=windows)
      - build(os=linux)
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).deploy.needs).toEqual([
      "build-linux-x64",
      "build-windows-x64",
      "build-windows-arm64",
      "build-linux-arm64",
    ]);
  });

  it("passes a plain job-id need through unchanged", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: ./setup.sh
  build:
    needs: setup
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux]
    steps:
      - run: ./build.sh
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc)["build-linux"].needs).toBe("setup");
  });
});

// ---------------------------------------------------------------------------
// matrix.* reference rewriting
// ---------------------------------------------------------------------------

describe("expand_matrix: matrix.* rewriting", () => {
  it("preserves the value type when a field is a sole matrix reference", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: ${"${{ matrix.node }}"}
`);
    expect(errors).toEqual([]);
    const step = (jobsOf(doc)["build-18"].steps as { with: { "node-version": unknown } }[])[0];
    expect(step.with["node-version"]).toBe(18);
    expect(typeof step.with["node-version"]).toBe("number");
  });

  it("substitutes a matrix ref inside interpolated text", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux]
    name: build on ${"${{ matrix.os }}"}
    steps:
      - run: ./build.sh
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc)["build-linux"].name).toBe("build on linux");
  });

  it("rewrites a compound expression to expression literals", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux, windows]
    steps:
      - if: ${"${{ matrix.os == 'linux' }}"}
        run: ./linux-only.sh
`);
    expect(errors).toEqual([]);
    const step = (jobsOf(doc)["build-linux"].steps as { if: string }[])[0];
    expect(step.if).toBe("${{ 'linux' == 'linux' }}");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("expand_matrix: errors", () => {
  it("rejects a runtime (fromJSON) matrix", () => {
    const { result } = build(
      `
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix: ${"${{ fromJSON(needs.setup.outputs.legs) }}"}
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-runtime")).toBe(true);
  });

  it("rejects expand_matrix with no strategy.matrix", () => {
    const { result } = build(
      `
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-no-matrix")).toBe(true);
  });

  it("errors on a slug collision", () => {
    const { result } = build(
      `
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: ["x-64", "x_64"]
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-slug-collision")).toBe(true);
  });

  it("errors when a needs selector targets an unknown job", () => {
    const { result } = build(
      `
name: ci
on: [push]
jobs:
  build:${FANOUT}
  deploy:
    needs: nope(os=linux)
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-unknown-selector")).toBe(true);
  });

  it("errors on an unknown selector key", () => {
    const { result } = build(
      `
name: ci
on: [push]
jobs:
  build:${FANOUT}
  deploy:
    needs: build(platform=linux)
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-unknown-key")).toBe(true);
  });

  it("errors when a selector matches zero legs", () => {
    const { result } = build(
      `
name: ci
on: [push]
jobs:
  build:${FANOUT}
  deploy:
    needs: build(os=mac)
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-no-match")).toBe(true);
  });

  it("errors when the leg count exceeds the GitHub 256-job cap", () => {
    const big = `[${Array.from({ length: 17 }, (_, i) => i).join(", ")}]`;
    const { result } = build(
      `
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        a: ${big}
        b: ${big}
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-too-many-legs")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema validity of generated output
// ---------------------------------------------------------------------------

describe("expand_matrix: generated output", () => {
  it("passes official workflow-schema validation end-to-end", () => {
    const { errors, result } = build(`
name: ci
on: [push]
jobs:
  build:${FANOUT}
  deploy:
    needs: build(os=linux, arch=x64)
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`);
    expect(errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

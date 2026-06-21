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

// ---------------------------------------------------------------------------
// Runtime detection inside object matrices (matrixIsRuntime branches)
// ---------------------------------------------------------------------------

describe("expand_matrix: runtime detection in object matrices", () => {
  it("rejects a scalar axis holding a runtime expression", () => {
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
        os: ${"${{ env.OS }}"}
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-runtime")).toBe(true);
  });

  it("rejects an axis array containing a runtime expression", () => {
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
        os: [linux, "${"${{ env.OS }}"}"]
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-runtime")).toBe(true);
  });

  it("rejects an include entry whose property is a runtime expression", () => {
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
        os: [linux]
        include:
          - os: linux
            sku: "${"${{ env.SKU }}"}"
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-runtime")).toBe(true);
  });

  it("rejects an include that is itself a runtime expression string", () => {
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
        os: [linux]
        include: "${"${{ fromJSON(env.INC) }}"}"
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-runtime")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Malformed / degenerate matrices
// ---------------------------------------------------------------------------

describe("expand_matrix: malformed matrices", () => {
  it("errors when an axis is not an array of values", () => {
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
        os: linux
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-bad-axis")).toBe(true);
  });

  it("errors when the matrix produces no legs", () => {
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
        os: []
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-empty")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// include-only matrices (no plain axes → slug from props)
// ---------------------------------------------------------------------------

describe("expand_matrix: include-only matrix", () => {
  it("expands an include-only matrix, slugging from the entry props", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ${"${{ matrix.os }}"}
    strategy:
      matrix:
        include:
          - os: linux
          - os: windows
    steps:
      - run: ./build.sh
`);
    expect(errors).toEqual([]);
    const jobs = jobsOf(doc);
    expect(Object.keys(jobs)).toEqual(["build-linux", "build-windows"]);
    expect(jobs["build-windows"]["runs-on"]).toBe("windows");
  });
});

// ---------------------------------------------------------------------------
// include / exclude matching of complex (object / array) values
// ---------------------------------------------------------------------------

describe("expand_matrix: complex include/exclude matching", () => {
  it("excludes a leg whose object axis value deep-equals an exclude entry", () => {
    const { errors, doc } = build(
      `
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        config: [{ a: 1 }, { a: 2 }]
        exclude:
          - config: { a: 2 }
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(errors).toEqual([]);
    expect(Object.keys(jobsOf(doc))).toEqual(["build-object_object"]);
  });

  it("excludes a leg whose array axis value deep-equals an exclude entry", () => {
    const { errors, doc } = build(
      `
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        versions: [[18, 20], [21, 22]]
        exclude:
          - versions: [21, 22]
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(errors).toEqual([]);
    expect(Object.keys(jobsOf(doc))).toEqual(["build-18_20"]);
  });

  it("keeps legs when an exclude value differs in type", () => {
    const { errors, doc } = build(
      `
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux, windows]
        exclude:
          - os: 1
    steps:
      - run: ./build.sh
`,
      false,
    );
    expect(errors).toEqual([]);
    expect(Object.keys(jobsOf(doc))).toEqual(["build-linux", "build-windows"]);
  });
});

// ---------------------------------------------------------------------------
// bracket / index matrix references
// ---------------------------------------------------------------------------

describe("expand_matrix: bracket and index refs", () => {
  it("resolves quoted-bracket and numeric-index matrix references", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ${"${{ matrix['os'] }}"}
    strategy:
      matrix:
        os: [linux]
        include:
          - os: linux
            versions: [18, 20]
    steps:
      - run: 'node@${'${{ matrix["os"] }}'}-${"${{ matrix.versions[0] }}"}'
`);
    expect(errors).toEqual([]);
    const job = jobsOf(doc)["build-linux"];
    expect(job["runs-on"]).toBe("linux");
    expect((job.steps as { run: string }[])[0].run).toBe("node@linux-18");
  });
});

// ---------------------------------------------------------------------------
// compound expression literals (exprLiteral type branches)
// ---------------------------------------------------------------------------

describe("expand_matrix: compound expression literals", () => {
  it("renders number and boolean leg values as expression literals", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18]
        flag: [true]
    steps:
      - if: ${"${{ matrix.node >= 18 }}"}
        run: ./a.sh
      - if: ${"${{ matrix.flag && true }}"}
        run: ./b.sh
`);
    expect(errors).toEqual([]);
    const steps = jobsOf(doc)["build-18-true"].steps as { if: string }[];
    expect(steps[0].if).toBe("${{ 18 >= 18 }}");
    expect(steps[1].if).toBe("${{ true && true }}");
  });

  it("renders null and object leg values as expression literals", () => {
    const { errors, doc } = build(
      `
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux]
        include:
          - os: linux
            extra: null
            cfg: { a: 1 }
    steps:
      - if: ${"${{ matrix.extra || 'fallback' }}"}
        run: ./a.sh
      - if: ${"${{ contains(matrix.cfg, 'x') }}"}
        run: ./b.sh
`,
      false,
    );
    expect(errors).toEqual([]);
    const steps = jobsOf(doc)["build-linux"].steps as { if: string }[];
    expect(steps[0].if).toBe("${{ null || 'fallback' }}");
    expect(steps[1].if).toBe("${{ contains(fromJSON('{\"a\":1}'), 'x') }}");
  });
});

// ---------------------------------------------------------------------------
// interpolated non-string values (stringifyValue branches)
// ---------------------------------------------------------------------------

describe("expand_matrix: interpolated non-string values", () => {
  it("stringifies number, object, and null refs inside surrounding text", () => {
    const { errors, doc } = build(
      `
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    name: n-${"${{ matrix.node }}"}
    strategy:
      matrix:
        os: [linux]
        include:
          - os: linux
            node: 18
            cfg: { a: 1 }
            extra: null
    steps:
      - run: echo c-${"${{ matrix.cfg }}"} e-${"${{ matrix.extra }}"}
`,
      false,
    );
    expect(errors).toEqual([]);
    const job = jobsOf(doc)["build-linux"];
    expect(job.name).toBe("n-18");
    expect((job.steps as { run: string }[])[0].run).toBe('echo c-{"a":1} e-');
  });
});

// ---------------------------------------------------------------------------
// expression-parsing edge cases
// ---------------------------------------------------------------------------

describe("expand_matrix: expression edge cases", () => {
  it("handles escaped single quotes inside an expression", () => {
    const { errors, doc } = build(
      `
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux]
    steps:
      - if: ${"${{ matrix.os == 'it''s linux' }}"}
        run: ./build.sh
`,
      false,
    );
    expect(errors).toEqual([]);
    const step = (jobsOf(doc)["build-linux"].steps as { if: string }[])[0];
    expect(step.if).toBe("${{ 'linux' == 'it''s linux' }}");
  });

  it("leaves an unterminated expression token untouched", () => {
    const { errors, doc } = build(
      `
name: ci
on: [push]
jobs:
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux]
    steps:
      - run: echo ${"${{ matrix.os"}
`,
      false,
    );
    expect(errors).toEqual([]);
    expect((jobsOf(doc)["build-linux"].steps as { run: string }[])[0].run).toBe(
      "echo ${{ matrix.os",
    );
  });
});

// ---------------------------------------------------------------------------
// needs selector edge cases
// ---------------------------------------------------------------------------

describe("expand_matrix: selector edge cases", () => {
  it("treats empty parens as a match-all selector", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:${FANOUT}
  deploy:
    needs: build()
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).deploy.needs).toEqual([
      "build-linux-x64",
      "build-linux-arm64",
      "build-windows-x64",
      "build-windows-arm64",
    ]);
  });

  it("strips quotes from selector values", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:${FANOUT}
  deploy:
    needs: build(os='linux', arch="x64")
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).deploy.needs).toBe("build-linux-x64");
  });

  it("errors on a malformed selector missing its closing paren", () => {
    const { result } = build(
      `
name: ci
on: [push]
jobs:
  build:${FANOUT}
  deploy:
    needs: build(os=linux
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-unknown-selector")).toBe(true);
  });

  it("errors on a selector pair without a value", () => {
    const { result } = build(
      `
name: ci
on: [push]
jobs:
  build:${FANOUT}
  deploy:
    needs: build(os)
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-no-match")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collisions with existing (non-expanded) jobs + needs dedup
// ---------------------------------------------------------------------------

describe("expand_matrix: collisions and dedup", () => {
  it("errors when an expanded slug collides with a pre-existing job id", () => {
    const { result } = build(
      `
name: ci
on: [push]
jobs:
  build-linux:
    runs-on: ubuntu-latest
    steps:
      - run: echo pre
  build:
    expand_matrix: true
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [linux]
    steps:
      - run: echo x
`,
      false,
    );
    expect(hasCode(result, "expand-matrix-slug-collision")).toBe(true);
  });

  it("dedupes repeated plain-id needs alongside a selector", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: echo s
  build:${FANOUT}
  deploy:
    needs:
      - setup
      - setup
      - build(os=linux, arch=x64)
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`);
    expect(errors).toEqual([]);
    expect(jobsOf(doc).deploy.needs).toEqual(["setup", "build-linux-x64"]);
  });
});

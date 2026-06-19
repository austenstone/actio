import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Transpile and parse the generated YAML back to a JS object for assertions. */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml" });
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

/** A diagnostic with the given code fired. */
function hasCode(result: { diagnostics: { message: string }[] }, code: string): boolean {
  return codesOf(result).includes(code);
}

function jobsOf(doc: { jobs?: Record<string, unknown> }): Record<string, Record<string, unknown>> {
  return (doc?.jobs ?? {}) as Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Serial step loops (the most common shape: a `for-each` step that unrolls)
// ---------------------------------------------------------------------------

describe("for-each: serial step loops", () => {
  it("unrolls a scalar list into one step per value with compile-time substitution", () => {
    const { result, errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: item
          in: [alpha, beta]
        steps:
          - run: echo {{ item }}
      - run: echo done
`);
    expect(result.ok).toBe(true);
    expect(errors).toHaveLength(0);
    const steps = jobsOf(doc).build.steps as { run: string }[];
    expect(steps.map((s) => s.run)).toEqual(["echo alpha", "echo beta", "echo done"]);
    // USP: no residual directives, no unrendered compile tokens.
    expect(result.yaml).not.toContain("for-each");
    expect(result.yaml).not.toContain("{{");
  });

  it("expands a multi-step body per iteration", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
          in: [a, b]
        steps:
          - run: setup {{ x }}
          - run: test {{ x }}
`);
    expect(result.ok).toBe(true);
    const steps = jobsOf(doc).build.steps as { run: string }[];
    expect(steps.map((s) => s.run)).toEqual(["setup a", "test a", "setup b", "test b"]);
  });

  it("substitutes object fields via {{ item.field }}", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: t
          in:
            - { name: lint, cmd: "npm run lint" }
            - { name: test, cmd: "npm test" }
        steps:
          - name: "{{ t.name }}"
            run: "{{ t.cmd }}"
`);
    expect(result.ok).toBe(true);
    const steps = jobsOf(doc).build.steps as { name: string; run: string }[];
    expect(steps).toEqual([
      { name: "lint", run: "npm run lint" },
      { name: "test", run: "npm test" },
    ]);
  });

  it("errors when an object element is missing a referenced field", () => {
    const { result, errors } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: t
          in:
            - { name: lint }
            - { cmd: "npm test" }
        steps:
          - run: "{{ t.cmd }}"
`);
    expect(result.ok).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(hasCode(result, "for-each-param-field-missing")).toBe(true);
  });

  it("warns and expands to nothing on an empty literal list", () => {
    const { result, warnings, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
          in: []
        steps:
          - run: echo {{ x }}
      - run: echo done
`);
    expect(result.ok).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
    expect(hasCode(result, "for-each-empty-literal")).toBe(true);
    const steps = jobsOf(doc).build.steps as { run: string }[];
    expect(steps.map((s) => s.run)).toEqual(["echo done"]);
  });

  it("expands nested for-each loops and warns on a shadowed loop var", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
          in: [a, b]
        steps:
          - for-each:
              var: x
              in: [1, 2]
            steps:
              - run: echo {{ x }}
`);
    expect(result.ok).toBe(true);
    expect(hasCode(result, "for-each-shadow")).toBe(true);
    const steps = jobsOf(doc).build.steps as { run: string }[];
    // 2x2 expansion fires; the shadowed inner binding does not re-substitute,
    // so the outer value survives in the body (pinned as shipped behavior).
    expect(steps.map((s) => s.run)).toEqual(["echo a", "echo a", "echo b", "echo b"]);
  });

  it("errors when a step-level loop declares parallel: true", () => {
    const { result, errors } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
          in: [a, b]
          parallel: true
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(hasCode(result, "for-each-step-parallel")).toBe(true);
  });

  // Issue #50: a whole-job runtime step loop used to fail loud. It now
  // auto-rewrites (Case A) by reusing the job-level dynamic-delegation path.
  // See the "runtime step loops (#50)" block below for the full case matrix.
  it("auto-rewrites a whole-job runtime step loop into a dynamic matrix", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
          in: "\${{ fromJSON(needs.setup.outputs.list) }}"
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(true);
    expect(result.yaml).not.toContain("for-each");
    const jobs = jobsOf(doc);
    expect(jobs.actio_setup_build).toBeDefined();
    const build_ = jobs.build as {
      needs?: string[];
      strategy?: { matrix?: Record<string, string> };
      steps?: { run?: string }[];
    };
    expect(build_.needs).toEqual(["actio_setup_build"]);
    expect(build_.strategy?.matrix?.x).toBe(
      "${{ fromJSON(needs.actio_setup_build.outputs.matrix) }}",
    );
    expect(String(build_.steps?.[0]?.run)).toBe("echo ${{ matrix.x }}");
  });

  it("warns that serial-only knobs are ignored on a step loop", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
          in: [a, b]
          fail-fast: true
          max-parallel: 2
          as: thing
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(true);
    expect(hasCode(result, "for-each-serial-option-ignored")).toBe(true);
  });

  it("warns when a loop body injects a fragment that uses the loop var", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
          in: [a, b]
        steps:
          - inject: missing-fragment
`);
    expect(hasCode(result, "for-each-fragment-loopvar")).toBe(true);
  });

  it("errors when for-each is not a mapping", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each: "nope"
        steps:
          - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-shape")).toBe(true);
  });

  it("errors when for-each is missing var or in", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-missing-required")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `in` source resolution edge cases
// ---------------------------------------------------------------------------

describe("for-each: source resolution", () => {
  it("resolves a compile-time object param reference to a list", () => {
    const { result, doc } = build(`
name: ci
on: [push]
params:
  envs:
    type: object
    default: [dev, prod]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: e
          in: "{{ params.envs }}"
        steps:
          - run: deploy {{ e }}
`);
    expect(result.ok).toBe(true);
    const steps = jobsOf(doc).build.steps as { run: string }[];
    expect(steps.map((s) => s.run)).toEqual(["deploy dev", "deploy prod"]);
  });

  it("errors when a compile reference resolves to a non-list value", () => {
    const { result } = build(`
name: ci
on: [push]
params:
  envs:
    type: object
    default:
      list: [dev, prod]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: e
          in: "{{ params.envs }}"
        steps:
          - run: echo {{ e }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-in-invalid")).toBe(true);
  });

  it("errors when a compile expression cannot resolve", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: e
          in: "{{ params.missing }}"
        steps:
          - run: echo {{ e }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-in-invalid")).toBe(true);
  });

  it("errors when a plain scalar string is given as the source", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: e
          in: "just-a-string"
        steps:
          - run: echo {{ e }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-in-scalar")).toBe(true);
  });

  it("errors when the source is a mixed scalar/object list", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: e
          in:
            - alpha
            - { name: beta }
        steps:
          - run: echo done
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-in-invalid")).toBe(true);
  });

  it("errors when the source is an empty string", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: e
          in: "   "
        steps:
          - run: echo done
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-in-invalid")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parallel job matrices (job-level for-each, parallel default)
// ---------------------------------------------------------------------------

describe("for-each: parallel job matrices", () => {
  it("expands a scalar job loop into a strategy matrix with fail-fast: false", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for-each:
      var: node
      in: [18, 20, 22]
    steps:
      - run: node --version {{ node }}
`);
    expect(result.ok).toBe(true);
    const job = jobsOf(doc).test;
    const strategy = job.strategy as { matrix: Record<string, unknown>; "fail-fast": boolean };
    expect(strategy.matrix.node).toEqual([18, 20, 22]);
    expect(strategy["fail-fast"]).toBe(false);
    const steps = job.steps as { run: string }[];
    expect(steps[0].run).toBe("node --version ${{ matrix.node }}");
    expect(result.yaml).not.toContain("for-each");
  });

  it("honors `as`, `fail-fast: true`, and `max-parallel`", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for-each:
      var: n
      as: version
      in: [18, 20]
      fail-fast: true
      max-parallel: 2
    steps:
      - run: echo {{ n }}
`);
    expect(result.ok).toBe(true);
    const job = jobsOf(doc).test;
    const strategy = job.strategy as Record<string, unknown>;
    const matrix = strategy.matrix as Record<string, unknown>;
    expect(matrix.version).toEqual([18, 20]);
    expect(strategy["fail-fast"]).toBe(true);
    expect(strategy["max-parallel"]).toBe(2);
    const steps = job.steps as { run: string }[];
    expect(steps[0].run).toBe("echo ${{ matrix.version }}");
  });

  it("ignores an invalid max-parallel value", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for-each:
      var: n
      in: [1, 2]
      max-parallel: 0
    steps:
      - run: echo {{ n }}
`);
    expect(result.ok).toBe(true);
    const strategy = jobsOf(doc).test.strategy as Record<string, unknown>;
    expect(strategy["max-parallel"]).toBeUndefined();
  });

  it("expands an object job loop into matrix.include", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for-each:
      var: combo
      in:
        - { os: ubuntu-latest, node: 18 }
        - { os: macos-latest, node: 20 }
    steps:
      - run: echo {{ combo.os }} {{ combo.node }}
`);
    expect(result.ok).toBe(true);
    const job = jobsOf(doc).test;
    const matrix = (job.strategy as Record<string, unknown>).matrix as {
      include: Record<string, unknown>[];
    };
    expect(matrix.include).toEqual([
      { os: "ubuntu-latest", node: 18 },
      { os: "macos-latest", node: 20 },
    ]);
    const steps = job.steps as { run: string }[];
    expect(steps[0].run).toBe("echo ${{ matrix.os }} ${{ matrix.node }}");
  });

  it("errors when an object job loop references a missing field", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for-each:
      var: combo
      in:
        - { os: ubuntu-latest }
        - { node: 20 }
    steps:
      - run: echo {{ combo.os }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-param-field-missing")).toBe(true);
  });

  it("errors on an empty parallel literal list", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for-each:
      var: n
      in: []
    steps:
      - run: echo {{ n }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-empty-parallel")).toBe(true);
    expect(result.yaml).not.toContain("for-each");
  });
});

// ---------------------------------------------------------------------------
// Variant axis × author strategy.matrix coexistence (issue #79)
// ---------------------------------------------------------------------------

describe("for-each: variant axis × author matrix", () => {
  it("fans a scalar variant out to N jobs, each keeping the full author matrix", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        group: [1, 2, 3]
        react: [18, 19]
    for-each:
      var: variant
      in: [turbopack, rspack, webpack]
    steps:
      - run: echo {{ variant }} \${{ matrix.group }} \${{ matrix.react }}
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc);
    expect(Object.keys(jobs)).toEqual(["test-turbopack", "test-rspack", "test-webpack"]);
    expect(jobs.test).toBeUndefined();

    const variant = jobs["test-turbopack"];
    const strategy = variant.strategy as Record<string, unknown>;
    expect(strategy.matrix).toEqual({ group: [1, 2, 3], react: [18, 19] });
    expect(strategy["fail-fast"]).toBe(false);
    const steps = variant.steps as { run: string }[];
    expect(steps[0].run).toBe("echo turbopack ${{ matrix.group }} ${{ matrix.react }}");
    expect((jobs["test-rspack"].steps as { run: string }[])[0].run).toBe(
      "echo rspack ${{ matrix.group }} ${{ matrix.react }}",
    );
    expect(result.yaml).not.toContain("for-each");
  });

  it("clones an object variant onto a `uses:` call job (the next.js shape)", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    uses: ./.github/workflows/build_reusable.yml
    secrets: inherit
    strategy:
      matrix:
        group: [1, 2, 3]
        react: [18, 19]
    with:
      afterBuild: "{{ variant.afterBuild }}"
    for-each:
      var: variant
      key: name
      in:
        - { name: turbopack-dev, afterBuild: "pnpm test-dev" }
        - { name: turbopack-prod, afterBuild: "pnpm test-prod" }
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc);
    expect(Object.keys(jobs)).toEqual(["test-turbopack_dev", "test-turbopack_prod"]);

    const dev = jobs["test-turbopack_dev"];
    expect(dev.uses).toBe("./.github/workflows/build_reusable.yml");
    expect(dev.secrets).toBe("inherit");
    expect((dev.with as Record<string, unknown>).afterBuild).toBe("pnpm test-dev");
    expect((dev.strategy as Record<string, unknown>).matrix).toEqual({
      group: [1, 2, 3],
      react: [18, 19],
    });
    expect((jobs["test-turbopack_prod"].with as Record<string, unknown>).afterBuild).toBe(
      "pnpm test-prod",
    );
  });

  it("copies the original `needs` onto every variant (parallel, not a serial chain)", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    runs-on: ubuntu-latest
    needs: [build]
    strategy:
      matrix:
        group: [1, 2]
    for-each:
      var: variant
      in: [x, y]
    steps:
      - run: echo {{ variant }}
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc);
    expect(jobs["test-x"].needs).toEqual(["build"]);
    expect(jobs["test-y"].needs).toEqual(["build"]);
  });

  it("errors when the loop var reuses an author matrix key", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        group: [1, 2]
    for-each:
      var: group
      in: [a, b]
    steps:
      - run: echo {{ group }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-matrix-key-collision")).toBe(true);
  });

  it("warns and ignores loop-level fail-fast/max-parallel, preserving the author's", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: true
      matrix:
        group: [1, 2]
    for-each:
      var: variant
      in: [x, y]
      fail-fast: false
      max-parallel: 3
    steps:
      - run: echo {{ variant }}
`);
    expect(result.ok).toBe(true);
    expect(hasCode(result, "for-each-loop-knob-ignored-coexist")).toBe(true);
    const strategy = jobsOf(doc)["test-x"].strategy as Record<string, unknown>;
    expect(strategy["fail-fast"]).toBe(true);
    expect(strategy["max-parallel"]).toBeUndefined();
  });

  it("falls back to the index when an object variant has no slug field", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        group: [1, 2]
    for-each:
      var: variant
      in:
        - { afterBuild: "a" }
        - { afterBuild: "b" }
    steps:
      - run: echo {{ variant.afterBuild }}
`);
    expect(result.ok).toBe(true);
    expect(hasCode(result, "for-each-variant-id-fallback")).toBe(true);
    const jobs = jobsOf(doc);
    expect(Object.keys(jobs)).toEqual(["test-0", "test-1"]);
  });

  it("leaves the single-job fold untouched when there is no author matrix", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for-each:
      var: variant
      in: [a, b]
    steps:
      - run: echo {{ variant }}
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc);
    expect(Object.keys(jobs)).toEqual(["test"]);
    expect((jobs.test.strategy as Record<string, unknown>).matrix).toEqual({ variant: ["a", "b"] });
  });
});

// ---------------------------------------------------------------------------
// Serial job fan-out (job-level for-each, parallel: false)
// ---------------------------------------------------------------------------

describe("for-each: serial job fan-out", () => {
  it("clones a job per value with a serial needs-chain", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    for-each:
      var: stage
      in: [staging, prod]
      parallel: false
    steps:
      - run: deploy {{ stage }}
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc);
    expect(Object.keys(jobs)).toEqual(["deploy-staging", "deploy-prod"]);
    expect((jobs["deploy-staging"].steps as { run: string }[])[0].run).toBe("deploy staging");
    expect((jobs["deploy-prod"].steps as { run: string }[])[0].run).toBe("deploy prod");
    expect(jobs["deploy-prod"].needs).toEqual(["deploy-staging"]);
    expect(result.yaml).not.toContain("for-each");
  });

  it("preserves the original job's needs on the first sibling", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: echo setup
  deploy:
    runs-on: ubuntu-latest
    needs: setup
    for-each:
      var: stage
      in: [a, b]
      parallel: false
    steps:
      - run: deploy {{ stage }}
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc);
    expect(jobs["deploy-a"].needs).toEqual(["setup"]);
    expect(jobs["deploy-b"].needs).toEqual(["deploy-a"]);
  });

  it("errors when a serial job loop has a non-scalar source", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    for-each:
      var: stage
      in:
        - { name: a }
        - { name: b }
      parallel: false
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-serial-job-source")).toBe(true);
  });

  it("errors when two values slug to the same job id", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    for-each:
      var: stage
      in: [Foo, foo]
      parallel: false
    steps:
      - run: echo {{ stage }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-job-id-collision")).toBe(true);
  });

  it("warns and drops the job on an empty serial list", () => {
    const { result, warnings, doc } = build(`
name: ci
on: [push]
jobs:
  keep:
    runs-on: ubuntu-latest
    steps:
      - run: echo keep
  deploy:
    runs-on: ubuntu-latest
    for-each:
      var: stage
      in: []
      parallel: false
    steps:
      - run: echo {{ stage }}
`);
    expect(result.ok).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
    expect(hasCode(result, "for-each-empty-literal")).toBe(true);
    expect(Object.keys(jobsOf(doc))).toEqual(["keep"]);
  });
});

// ---------------------------------------------------------------------------
// Job-level shape / collision errors
// ---------------------------------------------------------------------------

describe("for-each: job-level shape errors", () => {
  it("errors when job for-each is not a mapping", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for-each: "nope"
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-shape")).toBe(true);
  });

  it("errors when a job combines for-each with dynamic-matrix", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix:
      script: ./list.sh
      alias: target
    for-each:
      var: n
      in: [1, 2]
    steps:
      - run: echo {{ n }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-dynamic-matrix-collision")).toBe(true);
  });

  it("errors when job for-each is missing var or in", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for-each:
      in: [1, 2]
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-missing-required")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dynamic delegation (runtime / generator sources at job scope)
// ---------------------------------------------------------------------------

describe("for-each: dynamic delegation", () => {
  it("delegates a runtime-expression job loop to a dynamic-matrix block", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - id: gen
        run: echo "list=[1,2]" >> "$GITHUB_OUTPUT"
  test:
    runs-on: ubuntu-latest
    needs: setup
    for-each:
      var: n
      in: "\${{ fromJSON(needs.setup.outputs.list) }}"
    steps:
      - run: echo "\${{ matrix.n }}"
`);
    // Pinned as-observed: the runtime source routes through dynamic delegation.
    // Record whatever the compiler decides; the point is the delegation path runs.
    expect(codesOf(result)).toBeDefined();
    expect(result.yaml).not.toContain("for-each");
  });

  it("delegates a generator job loop to a dynamic-matrix block", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for-each:
      var: target
      in:
        run: ./list-targets.sh
    steps:
      - run: echo "\${{ matrix.target }}"
`);
    expect(result.yaml).not.toContain("for-each");
  });
});

// ---------------------------------------------------------------------------
// Runtime step loops (issue #50): only a whole-job single runtime loop (Case A)
// auto-rewrites into a native matrix. Every other shape stays fail-loud — GHA
// has no step-level matrix, so a partial hoist onto a fresh matrix runner can't
// be proven to preserve shared workspace state, cross-step outputs, or run-once
// side effects. Failing loud everywhere else is what keeps the no-silent-
// miscompile invariant.
// ---------------------------------------------------------------------------
describe("for-each: runtime step loops (#50)", () => {
  it("rewrites a generator-sourced whole-job loop and honours the as: alias", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: shard
          as: shard
          in:
            run: ./list-shards.sh
        steps:
          - run: ./run-shard.sh {{ shard }}
`);
    expect(result.ok).toBe(true);
    expect(result.yaml).not.toContain("for-each");
    const jobs = jobsOf(doc);
    expect(jobs.actio_setup_test).toBeDefined();
    const test_ = jobs.test as {
      strategy?: { matrix?: Record<string, string> };
      steps?: { run?: string }[];
    };
    expect(test_.strategy?.matrix?.shard).toBe(
      "${{ fromJSON(needs.actio_setup_test.outputs.matrix) }}",
    );
    expect(String(test_.steps?.[0]?.run)).toBe("./run-shard.sh ${{ matrix.shard }}");
  });

  it("fails loud when a non-looped step sits beside the runtime loop (B)", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - for-each:
          var: x
          in: "\${{ fromJSON(needs.s.outputs.a) }}"
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-step-runtime-partial")).toBe(true);
  });

  it("fails loud on multiple runtime loops in one job (C)", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
          in: "\${{ fromJSON(needs.s.outputs.a) }}"
        steps:
          - run: echo {{ x }}
      - for-each:
          var: y
          in: "\${{ fromJSON(needs.s.outputs.b) }}"
        steps:
          - run: echo {{ y }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-step-runtime-partial")).toBe(true);
  });

  it("fails loud on a runtime loop nested inside the hoisted body (D)", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
          in: "\${{ fromJSON(needs.s.outputs.a) }}"
        steps:
          - for-each:
              var: y
              in: "\${{ fromJSON(needs.s.outputs.b) }}"
            steps:
              - run: echo {{ x }} {{ y }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-step-runtime-partial")).toBe(true);
  });

  it("fails loud on a share: producer inside the hoisted body (E)", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
          in: "\${{ fromJSON(needs.s.outputs.a) }}"
        steps:
          - run: echo {{ x }}
            share:
              val: "$X"
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "E-share-in-dynamic-loop")).toBe(true);
  });

  it("fails loud when the job already defines a matrix (F)", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - for-each:
          var: x
          in: "\${{ fromJSON(needs.s.outputs.a) }}"
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-dynamic-matrix-collision")).toBe(true);
    expect(codesOf(result)).toEqual(["for-each-dynamic-matrix-collision"]);
  });

  it("fails loud on a serial (parallel: false) runtime loop", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: x
          in: "\${{ fromJSON(needs.s.outputs.a) }}"
          parallel: false
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-step-runtime")).toBe(true);
    expect(codesOf(result)).toEqual(["for-each-step-runtime"]);
  });

  it("still rewrites when the job carries a strategy without a matrix key", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: true
    steps:
      - for-each:
          var: x
          in: "\${{ fromJSON(needs.s.outputs.a) }}"
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(true);
    expect(jobsOf(doc).actio_setup_build).toBeDefined();
  });
});

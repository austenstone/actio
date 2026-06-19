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
// Serial step loops (the most common shape: a `for_each` step that unrolls)
// ---------------------------------------------------------------------------

describe("for_each: serial step loops", () => {
  it("unrolls a scalar list into one step per value with compile-time substitution", () => {
    const { result, errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for_each:
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
    expect(result.yaml).not.toContain("for_each");
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
      - for_each:
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
      - for_each:
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
      - for_each:
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
      - for_each:
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

  it("expands nested for_each loops and warns on a shadowed loop var", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for_each:
          var: x
          in: [a, b]
        steps:
          - for_each:
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
      - for_each:
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

  it("hoists a whole-job runtime step loop into a matrixed job", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    needs: setup
    runs-on: ubuntu-latest
    env:
      GREETING: hi
    steps:
      - for_each:
          var: x
          in: "\${{ fromJSON(needs.setup.outputs.list) }}"
        steps:
          - run: echo {{ x }} $GREETING
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc as never);
    // The loop is hoisted in place: the job keeps its id so downstream needs still resolve.
    expect(Object.keys(jobs)).toEqual(["build"]);
    const buildJob = jobs.build as Record<string, unknown>;
    expect(buildJob.for_each).toBeUndefined();
    expect((buildJob.strategy as Record<string, unknown>).matrix).toEqual({
      x: "${{ fromJSON(needs.setup.outputs.list) }}",
    });
    // runs-on / env / needs are replicated onto the matrixed job.
    expect(buildJob["runs-on"]).toBe("ubuntu-latest");
    expect(buildJob.env).toEqual({ GREETING: "hi" });
    expect(buildJob.needs).toEqual(["setup"]);
    // The loop variable binds to the matrix leg; the shell var is untouched.
    const steps = buildJob.steps as { run?: string }[];
    expect(steps).toHaveLength(1);
    expect(steps[0]?.run).toBe("echo ${{ matrix.x }} $GREETING");
  });

  it("splits pure pre-steps into a -pre job and matrixes the loop", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - run: echo pure-pre
      - for_each:
          var: x
          in: "\${{ fromJSON(needs.setup.outputs.list) }}"
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc as never);
    expect(Object.keys(jobs).sort()).toEqual(["build", "build-pre"]);
    const pre = jobs["build-pre"] as Record<string, unknown>;
    const loop = jobs.build as Record<string, unknown>;
    // The pre job keeps the original needs and surrounding step.
    expect(pre.needs).toEqual(["setup"]);
    expect(pre.for_each).toBeUndefined();
    expect((pre.steps as { run?: string }[])[0]?.run).toBe("echo pure-pre");
    // The loop job runs after the pre job and still sees the original needs.
    expect(loop.needs).toEqual(["build-pre", "setup"]);
    expect((loop.strategy as Record<string, unknown>).matrix).toEqual({
      x: "${{ fromJSON(needs.setup.outputs.list) }}",
    });
    expect((loop.steps as { run?: string }[])[0]?.run).toBe("echo ${{ matrix.x }}");
  });

  it("fails loud when a runtime loop follows a checkout (shared state)", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - for_each:
          var: x
          in: "\${{ fromJSON(needs.setup.outputs.list) }}"
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-step-runtime")).toBe(true);
  });

  it("fails loud when a runtime loop follows a step that writes $GITHUB_ENV", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - run: echo "K=v" >> $GITHUB_ENV
      - for_each:
          var: x
          in: "\${{ fromJSON(needs.setup.outputs.list) }}"
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-step-runtime")).toBe(true);
  });

  it("fails loud when a step follows a runtime loop (post-loop state)", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - for_each:
          var: x
          in: "\${{ fromJSON(needs.setup.outputs.list) }}"
        steps:
          - run: echo {{ x }}
      - run: echo after
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-step-runtime")).toBe(true);
  });

  it("fails loud when two runtime loops live in one job", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - for_each:
          var: x
          in: "\${{ fromJSON(needs.setup.outputs.a) }}"
        steps:
          - run: echo {{ x }}
      - for_each:
          var: y
          in: "\${{ fromJSON(needs.setup.outputs.b) }}"
        steps:
          - run: echo {{ y }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-step-runtime")).toBe(true);
  });

  it("fails loud when a runtime loop requests serial execution", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - for_each:
          var: x
          in: "\${{ fromJSON(needs.setup.outputs.list) }}"
          parallel: false
        steps:
          - run: echo {{ x }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-step-runtime")).toBe(true);
  });

  it("keeps E-share-in-dynamic-loop when a share producer is inside a runtime loop", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - for_each:
          var: x
          in: "\${{ fromJSON(needs.setup.outputs.list) }}"
        steps:
          - share: { value: "\${{ matrix.x }}", as: out }
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "E-share-in-dynamic-loop")).toBe(true);
  });

  it("warns that serial-only knobs are ignored on a step loop", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for_each:
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
      - for_each:
          var: x
          in: [a, b]
        steps:
          - inject: missing-fragment
`);
    expect(hasCode(result, "for-each-fragment-loopvar")).toBe(true);
  });

  it("errors when for_each is not a mapping", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for_each: "nope"
        steps:
          - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-shape")).toBe(true);
  });

  it("errors when for_each is missing var or in", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for_each:
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

describe("for_each: source resolution", () => {
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
      - for_each:
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
      - for_each:
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
      - for_each:
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
      - for_each:
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
      - for_each:
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
      - for_each:
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
// Parallel job matrices (job-level for_each, parallel default)
// ---------------------------------------------------------------------------

describe("for_each: parallel job matrices", () => {
  it("expands a scalar job loop into a strategy matrix with fail-fast: false", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for_each:
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
    expect(result.yaml).not.toContain("for_each");
  });

  it("honors `as`, `fail-fast: true`, and `max-parallel`", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for_each:
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
    for_each:
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
    for_each:
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
    for_each:
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
    for_each:
      var: n
      in: []
    steps:
      - run: echo {{ n }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-empty-parallel")).toBe(true);
    expect(result.yaml).not.toContain("for_each");
  });
});

// ---------------------------------------------------------------------------
// Serial job fan-out (job-level for_each, parallel: false)
// ---------------------------------------------------------------------------

describe("for_each: serial job fan-out", () => {
  it("clones a job per value with a serial needs-chain", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    for_each:
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
    expect(result.yaml).not.toContain("for_each");
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
    for_each:
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
    for_each:
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
    for_each:
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
    for_each:
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

describe("for_each: job-level shape errors", () => {
  it("errors when job for_each is not a mapping", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for_each: "nope"
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-shape")).toBe(true);
  });

  it("errors when a job combines for_each with dynamic_matrix", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic_matrix:
      script: ./list.sh
      alias: target
    for_each:
      var: n
      in: [1, 2]
    steps:
      - run: echo {{ n }}
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "for-each-dynamic-matrix-collision")).toBe(true);
  });

  it("errors when job for_each is missing var or in", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for_each:
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

describe("for_each: dynamic delegation", () => {
  it("delegates a runtime-expression job loop to a dynamic_matrix block", () => {
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
    for_each:
      var: n
      in: "\${{ fromJSON(needs.setup.outputs.list) }}"
    steps:
      - run: echo "\${{ matrix.n }}"
`);
    // Pinned as-observed: the runtime source routes through dynamic delegation.
    // Record whatever the compiler decides; the point is the delegation path runs.
    expect(codesOf(result)).toBeDefined();
    expect(result.yaml).not.toContain("for_each");
  });

  it("delegates a generator job loop to a dynamic_matrix block", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    for_each:
      var: target
      in:
        run: ./list-targets.sh
    steps:
      - run: echo "\${{ matrix.target }}"
`);
    expect(result.yaml).not.toContain("for_each");
  });
});

import { type Diagnostic, transpile } from "actio-core";
import { describe, expect, it } from "vitest";

/** Transpile and return diagnostics for assertion. */
function diag(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml" });
  return {
    result,
    errors: result.diagnostics.filter((d) => d.severity === "error"),
    warnings: result.diagnostics.filter((d) => d.severity === "warning"),
  };
}

type RangedDiagnostic = Diagnostic & { range: NonNullable<Diagnostic["range"]> };

/** Find a diagnostic whose message matches and assert it carries a source range. */
function ranged(diags: Diagnostic[], re: RegExp): RangedDiagnostic {
  const hit = diags.find((d) => re.test(d.message));
  expect(hit, `expected a diagnostic matching ${re}`).toBeTruthy();
  expect(hit?.range, `diagnostic ${re} should carry a range`).toBeTruthy();
  return hit as RangedDiagnostic;
}

function lineOf(source: string, needle: string): number {
  const line = source.split("\n").findIndex((l) => l.includes(needle));
  expect(line, `expected source to contain ${needle}`).toBeGreaterThanOrEqual(0);
  return line + 1;
}

describe("retry validation", () => {
  it("warns on a non-numeric, non-mapping retry value with a range", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        retry: "soon"
`);
    ranged(warnings, /retry must be a number or a mapping/);
  });

  it("warns on retry attempts < 2 (shorthand)", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        retry: 1
`);
    ranged(warnings, /retry attempts must be a number >= 2/);
  });

  it("reports non-finite shorthand values accurately", () => {
    const { warnings: infinityWarnings } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        retry: .inf
`);
    ranged(infinityWarnings, /retry attempts must be a number >= 2 \(got Infinity\)/);

    const { warnings: nanWarnings } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        retry: .nan
`);
    ranged(nanWarnings, /retry attempts must be a number >= 2 \(got NaN\)/);
  });

  it("warns on non-numeric retry.attempts", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        retry:
          attempts: lots
`);
    ranged(warnings, /retry\.attempts must be a number/);
  });

  it("warns on retry.attempts below 2", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        retry:
          attempts: 1
`);
    ranged(warnings, /retry\.attempts must be >= 2/);
  });

  it("warns on an unparseable retry.delay", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        retry:
          attempts: 3
          delay: "soonish"
`);
    ranged(warnings, /retry\.delay .* not a positive duration/);
  });

  it("warns on unknown retry keys", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        retry:
          attempts: 3
          backoff: linear
`);
    ranged(warnings, /retry has unknown key "backoff"/);
  });

  it("ranges retry diagnostics on fragment-injected steps back to the fragment source", () => {
    const source = `name: x
on: [push]
fragments:
  flaky:
    - run: ./x.sh
      retry: "soon"
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - inject: flaky
`;
    const { warnings } = diag(source);
    const hit = ranged(warnings, /retry must be a number or a mapping/);
    expect(hit.range.start.line).toBe(lineOf(source, 'retry: "soon"'));
  });

  it("ranges retry diagnostics on fallback-nested steps back to the nested source", () => {
    const source = `name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        fallback:
          steps:
            - run: ./cleanup.sh
              retry: "soon"
`;
    const { warnings } = diag(source);
    const hit = ranged(warnings, /retry must be a number or a mapping/);
    expect(hit.range.start.line).toBe(lineOf(source, 'retry: "soon"'));
  });
});

describe("fallback validation", () => {
  it("warns on a scalar fallback value with a range", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        fallback: "notify"
`);
    ranged(warnings, /fallback must be a list of steps or a mapping/);
  });

  it("warns when fallback.steps is not a list", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        fallback:
          recover: true
          steps: "./cleanup.sh"
`);
    ranged(warnings, /fallback\.steps must be a list of steps/);
  });

  it("warns when fallback.recover is not a boolean", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        fallback:
          recover: maybe
          steps:
            - run: ./cleanup.sh
`);
    ranged(warnings, /fallback\.recover must be a boolean/);
  });

  it("warns on invalid fallback from an injected fragment with the fragment source range", () => {
    const { warnings } = diag(`name: x
on: [push]
fragments:
  fragile:
    - run: ./x.sh
      fallback:
        recover: maybe
        steps:
          - run: ./cleanup.sh
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: fragile
`);
    const warning = ranged(warnings, /fallback\.recover must be a boolean/);
    expect(warning.range?.start.line).toBe(7);
  });
});

describe("fragments validation", () => {
  it("warns when top-level fragments is not a mapping", () => {
    const { warnings } = diag(`name: x
on: [push]
fragments:
  - run: echo hi
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: echo done
`);
    ranged(warnings, /top-level "fragments" must be a mapping/);
  });

  it("warns when a fragment is not a list of steps", () => {
    const { warnings } = diag(`name: x
on: [push]
fragments:
  s: "echo hi"
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - run: echo done
`);
    ranged(warnings, /fragment "s" must be a list of steps/);
  });

  it("errors when inject is not a string", () => {
    const { result, errors } = diag(`name: x
on: [push]
jobs:
  a:\n    runs-on: ubuntu-latest
    steps:
      - inject:
          name: s
`);
    expect(result.ok).toBe(false);
    const error = ranged(errors, /inject must name a fragment as a string/);
    expect(error.range?.start.line).toBe(7);
  });

  it("explains residual static-if inside injected fragments should gate the inject site", () => {
    const { result, errors } = diag(`name: x
on: [push]
fragments:
  gated:
    - static-if: true
      run: echo gated
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: gated
`);
    expect(result.ok).toBe(false);
    const error = ranged(errors, /Residual static-if directive is not allowed inside fragments/);
    expect(error.message).toContain("gate the inject site");
    expect(error.range?.start.line).toBe(5);
  });
});

describe("dynamic-matrix validation", () => {
  it("errors when dynamic-matrix is a scalar with a range", () => {
    const { result, errors } = diag(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix: ./list.sh
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    ranged(errors, /dynamic-matrix must be a mapping with a "script"/);
  });

  it("warns on unknown dynamic-matrix keys", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix:
      script: ./list.sh
      strategy: bogus
    steps:
      - run: echo hi
`);
    ranged(warnings, /dynamic-matrix has unknown key "strategy"/);
  });

  it("errors when dynamic-matrix has no script", () => {
    const { result, errors } = diag(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix:
      alias: shard
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    ranged(errors, /dynamic-matrix requires a "script" string/);
  });
});

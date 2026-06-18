import { transpile } from "actio-core";
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

/** Find a diagnostic whose message matches and assert it carries a source range. */
function ranged(diags: { message: string; range?: unknown }[], re: RegExp) {
  const hit = diags.find((d) => re.test(d.message));
  expect(hit, `expected a diagnostic matching ${re}`).toBeTruthy();
  expect((hit as { range?: unknown }).range, `diagnostic ${re} should carry a range`).toBeTruthy();
  return hit as { message: string; range?: unknown };
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
    expect(errors.some((d) => /inject must name a fragment as a string/.test(d.message))).toBe(
      true,
    );
  });
});

describe("dynamic_matrix validation", () => {
  it("errors when dynamic_matrix is a scalar with a range", () => {
    const { result, errors } = diag(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic_matrix: ./list.sh
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    ranged(errors, /dynamic_matrix must be a mapping with a "script"/);
  });

  it("warns on unknown dynamic_matrix keys", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic_matrix:
      script: ./list.sh
      strartegy: bogus
    steps:
      - run: echo hi
`);
    ranged(warnings, /dynamic_matrix has unknown key "strartegy"/);
  });

  it("errors when dynamic_matrix has no script", () => {
    const { result, errors } = diag(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic_matrix:
      alias: shard
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    ranged(errors, /dynamic_matrix requires a "script" string/);
  });
});

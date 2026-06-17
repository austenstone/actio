import { transpile } from "@actio/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Transpile and parse the generated YAML back to a JS object for assertions. */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml" });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  return { result, errors, doc: result.ok ? parse(result.yaml) : undefined };
}

describe("fragments", () => {
  it("expands inject in place", () => {
    const { doc, errors } = build(`name: x
on: [push]
fragments:
  s:
    - uses: actions/checkout@v4
    - run: echo hi
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: s
      - run: echo done
`);
    expect(errors).toEqual([]);
    expect(doc.fragments).toBeUndefined();
    expect(doc.jobs.a.steps).toEqual([
      { uses: "actions/checkout@v4" },
      { run: "echo hi" },
      { run: "echo done" },
    ]);
  });

  it("errors on an unknown fragment", () => {
    const { result } = build(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: nope
`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => /Unknown fragment "nope"/.test(d.message))).toBe(true);
  });

  it("detects fragment cycles", () => {
    const { result } = build(`name: x
on: [push]
fragments:
  a:
    - inject: b
  b:
    - inject: a
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - inject: a
`);
    expect(result.diagnostics.some((d) => /cycle/i.test(d.message))).toBe(true);
  });
});

describe("dynamic_matrix", () => {
  const src = `name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic_matrix:
      script: ./list.sh
      alias: shard
    steps:
      - run: ./t.sh ${"${{"} matrix.shard }}
`;

  it("creates a setup job that emits compact JSON via heredoc", () => {
    const { doc } = build(src);
    const setup = doc.jobs.actio_setup_test;
    expect(setup).toBeDefined();
    expect(setup.outputs.matrix).toBe("${{ steps.actio_eval.outputs.matrix }}");
    const evalStep = setup.steps.find((s: { id?: string }) => s.id === "actio_eval");
    expect(evalStep.run).toContain("jq -c .");
    expect(evalStep.run).toContain("matrix<<ACTIO_EOF");
    expect(evalStep.run).toContain('>> "$GITHUB_OUTPUT"');
  });

  it("wires needs, fromJSON matrix, fail-fast:false and an empty-matrix guard", () => {
    const { doc } = build(src);
    const job = doc.jobs.test;
    expect(job.needs).toEqual(["actio_setup_test"]);
    expect(job.strategy.matrix.shard).toBe(
      "${{ fromJSON(needs.actio_setup_test.outputs.matrix) }}",
    );
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(job.if).toContain("!= '[]'");
    expect(job.if).toContain("!= ''");
  });

  it("auto-adds checkout when the script is a local path", () => {
    const { doc } = build(src);
    expect(doc.jobs.actio_setup_test.steps[0]).toEqual({ uses: "actions/checkout@v4" });
  });

  it("skips checkout for inline commands", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic_matrix:
      script: echo '["a","b"]'
    steps:
      - run: echo hi
`);
    const first = doc.jobs.actio_setup_test.steps[0];
    expect(first.uses).toBeUndefined();
    expect(first.id).toBe("actio_eval");
  });

  it("supports raw (alias-less) matrix mode", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic_matrix:
      script: ./m.sh
    steps:
      - run: echo hi
`);
    expect(doc.jobs.test.strategy.matrix).toBe(
      "${{ fromJSON(needs.actio_setup_test.outputs.matrix) }}",
    );
  });
});

describe("fallback", () => {
  it("step-level notify keeps the job failing and scopes to the step conclusion", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  d:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        run: ./deploy.sh
        fallback:
          - name: Notify
            run: ./notify.sh
`);
    const steps = doc.jobs.d.steps;
    expect(steps[0].id).toBe("step_deploy");
    expect(steps[0]["continue-on-error"]).toBeUndefined();
    expect(steps[1].if).toBe("failure() && steps.step_deploy.conclusion == 'failure'");
  });

  it("step-level recover sets continue-on-error and uses outcome", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  f:
    runs-on: ubuntu-latest
    steps:
      - name: Flaky
        run: ./x.sh
        fallback:
          recover: true
          steps:
            - run: ./cleanup.sh
`);
    const steps = doc.jobs.f.steps;
    expect(steps[0]["continue-on-error"]).toBe(true);
    expect(steps[1].if).toBe("steps.step_flaky.outcome == 'failure'");
  });

  it("job-level fallback appends failure() steps", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: make build
    fallback:
      - name: Report
        run: ./report.sh
`);
    const steps = doc.jobs.b.steps;
    expect(steps[steps.length - 1].if).toBe("failure()");
    expect(doc.jobs.b.fallback).toBeUndefined();
  });
});

describe("passthrough", () => {
  it("leaves a macro-free workflow semantically intact", () => {
    const { doc, errors } = build(`name: x
on:
  push:
    branches: [main]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo one
          echo two
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps[0].run).toBe("echo one\necho two\n");
    expect(doc.on.push.branches).toEqual(["main"]);
  });
});

import {
  applyDefaults,
  applyExecutor,
  JOB_DEFAULTS_SAFE_SUBSET,
  type Job,
  parseActio,
  runPasses,
  transpile,
} from "actio-core";
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

describe("flatten rule (anchors)", () => {
  it("splices a `- *alias` sequence into job steps and strips `_anchors`", () => {
    const { doc, errors } = build(`name: x
on: [push]
_anchors:
  setup: &setup
    - uses: actions/checkout@v4
    - run: echo hi
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - *setup
      - run: npm ci
`);
    expect(errors).toEqual([]);
    expect(doc._anchors).toBeUndefined();
    expect(doc.jobs.a.steps).toEqual([
      { uses: "actions/checkout@v4" },
      { run: "echo hi" },
      { run: "npm ci" },
    ]);
  });

  it("flattens nested aliases recursively", () => {
    const { doc, errors } = build(`name: x
on: [push]
_anchors:
  inner: &inner
    - run: inner
  outer: &outer
    - run: before
    - *inner
    - run: after
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - *outer
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps).toEqual([{ run: "before" }, { run: "inner" }, { run: "after" }]);
  });

  it("flattens a `- *alias` inside a step-level fallback list", () => {
    const { doc, errors } = build(`name: x
on: [push]
_anchors:
  recover: &recover
    - run: cleanup
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: flaky
        fallback:
          - *recover
          - run: notify
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps.map((s: { run?: string }) => s.run)).toEqual([
      "flaky",
      "cleanup",
      "notify",
    ]);
  });

  it("flattens a `- *alias` inside a fallback.steps block", () => {
    const { doc, errors } = build(`name: x
on: [push]
_anchors:
  recover: &recover
    - run: cleanup
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: flaky
        fallback:
          recover: true
          steps:
            - *recover
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps.map((s: { run?: string }) => s.run)).toEqual(["flaky", "cleanup"]);
  });

  it("leaves a whole-value `steps: *alias` untouched", () => {
    const { doc, errors } = build(`name: x
on: [push]
_anchors:
  all: &all
    - uses: actions/checkout@v4
    - run: echo hi
jobs:
  a:
    runs-on: ubuntu-latest
    steps: *all
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps).toEqual([{ uses: "actions/checkout@v4" }, { run: "echo hi" }]);
  });
});

describe("dynamic-matrix", () => {
  const src = `name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix:
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

  it("keeps inline strategy over dynamic-matrix while dynamic-matrix still writes missing strategy", () => {
    const { doc, errors } = build(`name: x
on: [push]
jobs:
  inline_wins:
    runs-on: ubuntu-latest
    dynamic-matrix:
      script: echo '["x"]'
      alias: shard
    strategy:
      matrix:
        keep: [manual]
      fail-fast: true
    steps:
      - run: echo \${{ matrix.keep }}
  dynamic_matrix:
    runs-on: ubuntu-latest
    dynamic-matrix:
      script: echo '["y"]'
      alias: shard
    steps:
      - run: echo \${{ matrix.shard }}
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.inline_wins.strategy).toEqual({
      matrix: { keep: ["manual"] },
      "fail-fast": true,
    });
    expect(doc.jobs.dynamic_matrix.strategy).toEqual({
      matrix: { shard: "${{ fromJSON(needs.actio_setup_dynamic_matrix.outputs.matrix) }}" },
      "fail-fast": false,
    });
  });

  it("applies fail-fast precedence as inline > dynamic-matrix > default", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
jobs:
  inline_full:
    runs-on: ubuntu-latest
    dynamic-matrix:
      script: echo '["x"]'
      alias: shard
      fail-fast: false
    strategy:
      matrix:
        keep: [manual]
      fail-fast: true
    steps:
      - run: echo \${{ matrix.keep }}
  inline_missing_fail_fast:
    runs-on: ubuntu-latest
    dynamic-matrix:
      script: echo '["y"]'
      alias: shard
      fail-fast: false
    strategy:
      matrix:
        keep: [manual]
    steps:
      - run: echo \${{ matrix.keep }}
  dynamic_only:
    runs-on: ubuntu-latest
    dynamic-matrix:
      script: echo '["z"]'
      alias: shard
      fail-fast: true
    steps:
      - run: echo \${{ matrix.shard }}
  implicit_default:
    runs-on: ubuntu-latest
    dynamic-matrix:
      script: echo '["q"]'
      alias: shard
    steps:
      - run: echo \${{ matrix.shard }}
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.inline_full.strategy).toEqual({
      matrix: { keep: ["manual"] },
      "fail-fast": true,
    });
    expect(doc.jobs.inline_missing_fail_fast.strategy).toEqual({
      matrix: { keep: ["manual"] },
      "fail-fast": false,
    });
    expect(doc.jobs.dynamic_only.strategy).toEqual({
      matrix: { shard: "${{ fromJSON(needs.actio_setup_dynamic_only.outputs.matrix) }}" },
      "fail-fast": true,
    });
    expect(doc.jobs.implicit_default.strategy).toEqual({
      matrix: { shard: "${{ fromJSON(needs.actio_setup_implicit_default.outputs.matrix) }}" },
      "fail-fast": false,
    });
    expect(
      result.diagnostics.some(
        (d) =>
          d.severity === "warning" &&
          d.message.includes("inline strategy.fail-fast is preserved") &&
          d.message.includes("dynamic-matrix fail-fast is ignored"),
      ),
    ).toBe(true);
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
    dynamic-matrix:
      script: echo '["a","b"]'
    steps:
      - run: echo hi
`);
    const first = doc.jobs.actio_setup_test.steps[0];
    expect(first.uses).toBeUndefined();
    expect(first.id).toBe("actio_eval");
  });

  it("wraps a multi-line inline script in a group so the whole block feeds jq", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix:
      script: |
        a=1
        echo "[$a]"
    steps:
      - run: echo hi
`);
    const evalStep = doc.jobs.actio_setup_test.steps.find(
      (s: { id?: string }) => s.id === "actio_eval",
    );
    expect(evalStep.run).toContain("    a=1");
    expect(evalStep.run).toContain('    echo "[$a]"');
    expect(evalStep.run).toContain("  } | jq -c .");
    // The old bug: a dangling `| jq` on its own line (pipe with no left command).
    expect(/\n\s*\| jq/.test(evalStep.run)).toBe(false);
  });

  it("keeps single-line inline scripts piped inline with no group", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix:
      script: echo '["a","b"]'
    steps:
      - run: echo hi
`);
    const evalStep = doc.jobs.actio_setup_test.steps.find(
      (s: { id?: string }) => s.id === "actio_eval",
    );
    expect(evalStep.run).toContain(`echo '["a","b"]' | jq -c .`);
    expect(evalStep.run).not.toContain("  } | jq -c .");
  });

  it("emits PowerShell plumbing for shell: pwsh", () => {
    const { doc, errors } = build(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix:
      shell: pwsh
      script: |
        $d = Get-ChildItem -Directory packages | ForEach-Object { $_.Name }
        $d | ConvertTo-Json -Compress
    steps:
      - run: echo hi
`);
    expect(errors).toEqual([]);
    const evalStep = doc.jobs.actio_setup_test.steps.find(
      (s: { id?: string }) => s.id === "actio_eval",
    );
    expect(evalStep.shell).toBe("pwsh");
    expect(evalStep.run).toContain("$actioOut = & {");
    expect(evalStep.run).toContain("[System.IO.File]::AppendAllText($env:GITHUB_OUTPUT");
    expect(evalStep.run).toContain("UTF8Encoding $false");
    // No bash plumbing leaked in.
    expect(evalStep.run).not.toContain("jq -c .");
    expect(evalStep.run).not.toContain('>> "$GITHUB_OUTPUT"');
  });

  it("emits Python plumbing for shell: python", () => {
    const { doc, errors } = build(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix:
      shell: python
      script: |
        import json, pathlib
        print(json.dumps([p.name for p in pathlib.Path("packages").iterdir()]))
    steps:
      - run: echo hi
`);
    expect(errors).toEqual([]);
    const evalStep = doc.jobs.actio_setup_test.steps.find(
      (s: { id?: string }) => s.id === "actio_eval",
    );
    expect(evalStep.shell).toBe("python");
    expect(evalStep.run).toContain("contextlib.redirect_stdout(_actio_buf)");
    expect(evalStep.run).toContain('os.environ["GITHUB_OUTPUT"]');
    // User script is captured inside the redirect block (indented 4 spaces).
    expect(evalStep.run).toContain("    import json, pathlib");
    expect(evalStep.run).not.toContain("jq -c .");
  });

  it("errors on an unsupported shell", () => {
    const { result, errors } = build(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix:
      shell: cmd
      script: echo ["a"]
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => /shell "cmd" is not supported/.test(d.message))).toBe(true);
  });

  it("warns that compact is ignored for non-POSIX shells", () => {
    const { result } = build(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix:
      shell: pwsh
      compact: true
      script: '"[1]"'
    steps:
      - run: echo hi
`);
    const warns = result.diagnostics.filter((d) => d.severity === "warning");
    expect(warns.some((d) => /compact.*only applies to bash\/sh/.test(d.message))).toBe(true);
  });

  it("supports raw (alias-less) matrix mode", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic-matrix:
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

describe("job-defaults + executors", () => {
  it("partitions uses jobs and reports skipped runner defaults", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
job-defaults:
  if: \${{ github.ref == 'refs/heads/main' }}
  permissions:
    contents: read
  concurrency:
    group: ci
  runs-on: ubuntu-latest
  timeout-minutes: 15
  env:
    CI: "true"
jobs:
  call:
    uses: org/repo/.github/workflows/reuse.yml@main
    if: \${{ success() }}
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`);
    expect(errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(doc.jobs.call.uses).toBe("org/repo/.github/workflows/reuse.yml@main");
    expect(doc.jobs.call["runs-on"]).toBeUndefined();
    expect(doc.jobs.call.env).toBeUndefined();
    expect(doc.jobs.call["timeout-minutes"]).toBeUndefined();
    expect(doc.jobs.call.if).toBe("github.ref == 'refs/heads/main' && success()");
    expect(doc.jobs.call.permissions).toEqual({ contents: "read" });
    expect(doc.jobs.call.concurrency).toEqual({ group: "ci" });
    expect(doc.jobs.call.strategy).toBeUndefined();
    expect(doc.jobs.test.strategy).toBeUndefined();

    const infos = result.diagnostics.filter((d) => d.severity === "info");
    expect(infos.some((d) => d.message.includes("job-defaults-uses-skipped"))).toBe(true);
  });

  it("rejects job-defaults strategy with a per-job guidance diagnostic", () => {
    const { result, errors } = build(`name: x
on: [push]
job-defaults:
  strategy:
    fail-fast: false
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(
      errors.some((d) =>
        d.message.includes(
          'Key "strategy" is not allowed in job-defaults; declare strategy on each job instead',
        ),
      ),
    ).toBe(true);
  });

  it("preserves per-job strategy when applying other job-defaults", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
job-defaults:
  timeout-minutes: 15
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [a, b]
    steps:
      - run: echo \${{ matrix.shard }}
`);
    expect(result.ok).toBe(true);
    expect(errors).toEqual([]);
    expect(doc.jobs.test["timeout-minutes"]).toBe(15);
    expect(doc.jobs.test.strategy).toEqual({
      "fail-fast": false,
      matrix: { shard: ["a", "b"] },
    });
  });

  it("errors on unknown executor names", () => {
    const { result, errors } = build(`name: x
on: [push]
executors:
  gpu:
    runs-on: [self-hosted, gpu]
jobs:
  train:
    executor: missing
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes("executor-unknown"))).toBe(true);
  });

  it("errors when job-defaults or executors are not mappings", () => {
    const { result, errors } = build(`name: x
on: [push]
job-defaults: bad
executors: bad
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes('"job-defaults" must be a mapping'))).toBe(true);
    expect(errors.some((d) => d.message.includes('"executors" must be a mapping'))).toBe(true);
  });

  it("errors when an executor definition is not a mapping", () => {
    const { result, errors } = build(`name: x
on: [push]
executors:
  bad: ubuntu-latest
  good:
    runs-on: ubuntu-latest
jobs:
  test:
    executor: good
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes('Executor "bad" must be a mapping'))).toBe(true);
  });

  it("rejects unsupported keys in executor definitions", () => {
    for (const key of ["strategy", "if", "continue-on-error", "environment"]) {
      const { result, errors } = build(`name: x
on: [push]
executors:
  bad:
    ${key}: bad
jobs:
  test:
    executor: bad
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
      expect(result.ok).toBe(false);
      expect(errors.some((d) => d.message.includes("executor-rejected-key"))).toBe(true);
      const reason = key === "strategy" ? "not allowed here" : "not supported here";
      expect(errors.some((d) => d.message.includes(`Key "${key}" is ${reason}`))).toBe(true);
    }
  });

  it("errors when executor is used on a reusable-workflow call job", () => {
    const { result, errors } = build(`name: x
on: [push]
executors:
  linux:
    runs-on: ubuntu-latest
jobs:
  call:
    uses: org/repo/.github/workflows/reuse.yml@main
    executor: linux
`);
    expect(result.ok).toBe(false);
    expect(
      errors.some((d) =>
        d.message.includes('"executor" is not supported on reusable-workflow call jobs'),
      ),
    ).toBe(true);
  });

  it("errors when executor entries are not non-empty strings", () => {
    const { result, errors } = build(`name: x
on: [push]
executors:
  linux:
    runs-on: ubuntu-latest
jobs:
  test:
    executor: [linux, "  ", 1]
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(
      errors.some((d) => d.message.includes("executor entries must be non-empty strings")),
    ).toBe(true);
  });

  it("warns when executor is an empty list", () => {
    const { result, errors } = build(`name: x
on: [push]
executors:
  linux:
    runs-on: ubuntu-latest
jobs:
  test:
    executor: []
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(true);
    expect(errors).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("[executor-empty]"),
      ),
    ).toBe(true);
  });

  it("exports helper APIs and preserves stripped templates for downstream passes", () => {
    expect(typeof applyDefaults).toBe("function");
    expect(typeof applyExecutor).toBe("function");
    expect(JOB_DEFAULTS_SAFE_SUBSET).toEqual(
      new Set(["if", "permissions", "concurrency", "env", "timeout-minutes"]),
    );

    const source = `name: x
on: [push]
job-defaults:
  timeout-minutes: 11
  env:
    CI: "true"
executors:
  hardened:
    env:
      HARDENED: "true"
jobs:
  test:
    executor: hardened
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const ctx = parseActio(source, "t.actio.yml");
    runPasses(ctx);

    expect(ctx.internal.jobDefaults?.jobDefaults).toEqual({
      "timeout-minutes": 11,
      env: { CI: "true" },
    });
    expect(ctx.internal.jobDefaults?.executors).toEqual({
      hardened: { env: { HARDENED: "true" } },
    });
    expect(ctx.data["job-defaults"]).toBeUndefined();
    expect(ctx.data.executors).toBeUndefined();

    const emitted = parse(transpile(source, { fileName: "t.actio.yml" }).yaml);
    expect(emitted["job-defaults"]).toBeUndefined();
    expect(emitted.executors).toBeUndefined();

    const singleJob: Job = {
      "runs-on": "ubuntu-latest",
      steps: [{ run: "echo hi" }],
    };
    applyDefaults(singleJob, { "timeout-minutes": 22 });
    applyExecutor(singleJob, { env: { EXECUTOR: "true" } });
    expect(singleJob["timeout-minutes"]).toBe(22);
    expect(singleJob.env).toEqual({ EXECUTOR: "true" });

    const blankIfJob: Job = { if: "" };
    applyDefaults(blankIfJob, { if: "" });
    expect(blankIfJob.if).toBeUndefined();
    expect(Object.hasOwn(blankIfJob, "if")).toBe(false);
  });

  it("AND-combines wrapped expressions without mangling runtime syntax", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
job-defaults:
  if: \${{ github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/') }}
jobs:
  test:
    runs-on: ubuntu-latest
    if: \${{ success() || cancelled() }}
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(true);
    expect(errors).toEqual([]);
    expect(doc.jobs.test.if).toBe(
      "(github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')) && (success() || cancelled())",
    );
  });

  it("replaces permissions map when a job defines its own permissions", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
job-defaults:
  runs-on: ubuntu-latest
  permissions:
    contents: read
jobs:
  test:
    permissions:
      issues: write
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(true);
    expect(errors).toEqual([]);
    expect(doc.jobs.test.permissions).toEqual({ issues: "write" });
  });

  it("applies and replaces continue-on-error/environment from job-defaults", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
job-defaults:
  continue-on-error: true
  environment: staging
jobs:
  inherit:
    runs-on: ubuntu-latest
    steps:
      - run: echo inherit
  replace:
    runs-on: ubuntu-latest
    continue-on-error: false
    environment:
      name: production
    steps:
      - run: echo replace
`);
    expect(result.ok).toBe(true);
    expect(errors).toEqual([]);
    expect(doc.jobs.inherit["continue-on-error"]).toBe(true);
    expect(doc.jobs.inherit.environment).toBe("staging");
    expect(doc.jobs.replace["continue-on-error"]).toBe(false);
    expect(doc.jobs.replace.environment).toEqual({ name: "production" });
  });

  it("composes executor arrays left-to-right and keeps job inline keys authoritative", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
executors:
  hardened:
    permissions:
      contents: read
    concurrency:
      group: hardened-group
    defaults:
      run:
        shell: bash
    env:
      HARDENED: "true"
    timeout-minutes: 10
  gpu:
    runs-on: [self-hosted, gpu]
    container:
      image: nvidia/cuda:12.4.0-base
  fast:
    runs-on: ubuntu-latest
    env:
      FAST: "true"
    timeout-minutes: 5
jobs:
  release:
    executor: [hardened, gpu]
    steps:
      - run: echo release
  tuned:
    executor: [hardened, fast]
    runs-on: windows-latest
    steps:
      - run: echo tuned
`);
    expect(result.ok).toBe(true);
    expect(errors).toEqual([]);
    expect(doc.jobs.release.env).toEqual({ HARDENED: "true" });
    expect(doc.jobs.release["timeout-minutes"]).toBe(10);
    expect(doc.jobs.release.permissions).toEqual({ contents: "read" });
    expect(doc.jobs.release.concurrency).toEqual({ group: "hardened-group" });
    expect(doc.jobs.release.defaults).toEqual({ run: { shell: "bash" } });
    expect(doc.jobs.release["runs-on"]).toEqual(["self-hosted", "gpu"]);
    expect(doc.jobs.release.container).toEqual({ image: "nvidia/cuda:12.4.0-base" });

    expect(doc.jobs.tuned.env).toEqual({ HARDENED: "true", FAST: "true" });
    expect(doc.jobs.tuned["timeout-minutes"]).toBe(5);
    expect(doc.jobs.tuned.permissions).toEqual({ contents: "read" });
    expect(doc.jobs.tuned.concurrency).toEqual({ group: "hardened-group" });
    expect(doc.jobs.tuned.defaults).toEqual({ run: { shell: "bash" } });
    expect(doc.jobs.tuned["runs-on"]).toBe("windows-latest");
  });

  it("replaces runs-on objects for REPLACE_KEYS across executor compose and apply", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
job-defaults:
  runs-on:
    group: default-group
    labels: default-label
executors:
  base:
    runs-on:
      group: base-group
      labels: base-label
  final:
    runs-on:
      group: final-group
jobs:
  test:
    executor: [base, final]
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(true);
    expect(errors).toEqual([]);
    expect(doc.jobs.test["runs-on"]).toEqual({ group: "final-group" });
  });

  it("rejects structural keys in job-defaults", () => {
    const { result, errors } = build(`name: x
on: [push]
job-defaults:
  steps:
    - run: echo nope
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes("job-defaults-rejected-key"))).toBe(true);
    expect(errors.some((d) => d.message.includes('Key "steps" is not allowed here'))).toBe(true);
  });
});

describe("call-templates + extends", () => {
  it("materializes a call job from a template before job-defaults partitions it", () => {
    const { errors, doc } = build(`name: x
on: [push]
call-templates:
  test:
    uses: ./.github/workflows/reuse.yml
    needs: build
    with:
      testTimingsArtifact: timings
    secrets: inherit
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  unit:
    extends: test
    with:
      afterBuild: pnpm test:unit
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.unit.uses).toBe("./.github/workflows/reuse.yml");
    expect(doc.jobs.unit.needs).toBe("build");
    expect(doc.jobs.unit.with).toEqual({
      testTimingsArtifact: "timings",
      afterBuild: "pnpm test:unit",
    });
    expect(doc.jobs.unit.secrets).toBe("inherit");
    expect(doc.jobs.unit.extends).toBeUndefined();
  });

  it("merges with shallow per-key, inline winning", () => {
    const { errors, doc } = build(`name: x
on: [push]
call-templates:
  test:
    uses: ./reuse.yml
    with:
      shared: base
      kept: base-kept
jobs:
  unit:
    extends: test
    with:
      shared: inline
      added: inline-added
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.unit.with).toEqual({
      shared: "inline",
      kept: "base-kept",
      added: "inline-added",
    });
  });

  it("unions needs across templates and inline, order-preserving", () => {
    const { errors, doc } = build(`name: x
on: [push]
call-templates:
  base:
    uses: ./reuse.yml
    needs: build
  extra:
    needs: lint
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
  unit:
    extends: [base, extra]
    needs: deploy
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.unit.needs).toEqual(["build", "lint", "deploy"]);
  });

  it("merges secrets maps but lets a string replace", () => {
    const { errors, doc } = build(`name: x
on: [push]
call-templates:
  mapsecrets:
    uses: ./reuse.yml
    secrets:
      A: \${{ secrets.A }}
  stringsecrets:
    uses: ./reuse.yml
    secrets: inherit
jobs:
  merged:
    extends: mapsecrets
    secrets:
      B: \${{ secrets.B }}
  replaced:
    extends: mapsecrets
    secrets: inherit
  fromstring:
    extends: stringsecrets
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.merged.secrets).toEqual({ A: "${{ secrets.A }}", B: "${{ secrets.B }}" });
    expect(doc.jobs.replaced.secrets).toBe("inherit");
    expect(doc.jobs.fromstring.secrets).toBe("inherit");
  });

  it("combines template and inline if with &&", () => {
    const { errors, doc } = build(`name: x
on: [push]
call-templates:
  test:
    uses: ./reuse.yml
    if: \${{ github.event_name == 'push' }}
jobs:
  unit:
    extends: test
    if: \${{ success() }}
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.unit.if).toBe("github.event_name == 'push' && success()");
  });

  it("lets an inline key win over the template (uses replace)", () => {
    const { errors, doc } = build(`name: x
on: [push]
call-templates:
  test:
    uses: ./base.yml
jobs:
  unit:
    extends: test
    uses: ./inline.yml
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.unit.uses).toBe("./inline.yml");
  });

  it("rejects strategy/permissions/concurrency in a v1 template (quad only)", () => {
    for (const key of ["permissions", "concurrency", "strategy"]) {
      const { result, errors } = build(`name: x
on: [push]
call-templates:
  test:
    uses: ./reuse.yml
    ${key}:
      contents: write
jobs:
  unit:
    extends: test
`);
      expect(result.ok, key).toBe(false);
      expect(
        errors.some((d) => d.message.includes("call-template-rejected-key")),
        key,
      ).toBe(true);
    }
  });

  it("composes a chain of templates left-to-right, later winning", () => {
    const { errors, doc } = build(`name: x
on: [push]
call-templates:
  a:
    uses: ./a.yml
    with:
      v: from-a
  b:
    with:
      v: from-b
jobs:
  unit:
    extends: [a, b]
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.unit.uses).toBe("./a.yml");
    expect(doc.jobs.unit.with).toEqual({ v: "from-b" });
  });

  it("resolves {{ params.* }} inside a call template", () => {
    const { errors, doc } = build(`name: x
on: [push]
params:
  flow:
    type: string
    default: reuse
call-templates:
  test:
    uses: ./.github/workflows/{{ params.flow }}.yml
jobs:
  unit:
    extends: test
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.unit.uses).toBe("./.github/workflows/reuse.yml");
  });

  it("errors when call-templates is not a mapping", () => {
    const { result, errors } = build(`name: x
on: [push]
call-templates: nope
jobs:
  unit:
    uses: ./reuse.yml
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes('"call-templates" must be a mapping'))).toBe(true);
  });

  it("errors when a template definition is not a mapping", () => {
    const { result, errors } = build(`name: x
on: [push]
call-templates:
  test: ./reuse.yml
jobs:
  unit:
    extends: test
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes('Call template "test" must be a mapping'))).toBe(
      true,
    );
  });

  it("rejects unsupported keys in a template definition", () => {
    const { result, errors } = build(`name: x
on: [push]
call-templates:
  test:
    uses: ./reuse.yml
    runs-on: ubuntu-latest
jobs:
  unit:
    extends: test
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes("call-template-rejected-key"))).toBe(true);
  });

  it("errors on an unknown template name", () => {
    const { result, errors } = build(`name: x
on: [push]
call-templates:
  test:
    uses: ./reuse.yml
jobs:
  unit:
    extends: missing
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes("call-template-unknown"))).toBe(true);
  });

  it("rejects extends on a job that defines steps", () => {
    const { result, errors } = build(`name: x
on: [push]
call-templates:
  test:
    uses: ./reuse.yml
jobs:
  unit:
    extends: test
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes("extends-on-noncall-job"))).toBe(true);
  });

  it("rejects extends when no template in the chain provides uses", () => {
    const { result, errors } = build(`name: x
on: [push]
call-templates:
  partial:
    with:
      x: "1"
jobs:
  unit:
    extends: partial
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes("extends-on-noncall-job"))).toBe(true);
  });

  it("errors when extends is the wrong type", () => {
    const { result, errors } = build(`name: x
on: [push]
call-templates:
  test:
    uses: ./reuse.yml
jobs:
  unit:
    extends: 5
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes("extends must be a string or list"))).toBe(true);
  });
});

describe("templates (parameterized inject)", () => {
  it("injects a template and substitutes {{ args.* }} from with:", () => {
    const { doc, errors } = build(`name: x
on: [push]
templates:
  greet:
    params:
      who: { type: string }
    steps:
      - run: echo "hello {{ args.who }}"
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: greet
        with: { who: world }
      - run: done
`);
    expect(errors).toEqual([]);
    expect(doc.templates).toBeUndefined();
    expect(doc.jobs.a.steps).toEqual([{ run: 'echo "hello world"' }, { run: "done" }]);
  });

  it("expands the same template twice with different args", () => {
    const { doc, errors } = build(`name: x
on: [push]
templates:
  greet:
    params:
      who: { type: string }
    steps:
      - run: hi {{ args.who }}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: greet
        with: { who: ada }
      - inject: greet
        with: { who: linus }
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps).toEqual([{ run: "hi ada" }, { run: "hi linus" }]);
  });

  it("applies a param default when the arg is omitted", () => {
    const { doc, errors } = build(`name: x
on: [push]
templates:
  greet:
    params:
      who: { type: string, default: world }
    steps:
      - run: hi {{ args.who }}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: greet
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps).toEqual([{ run: "hi world" }]);
  });

  it("substitutes into a multi-step body and accepts number/enum params", () => {
    const { doc, errors } = build(`name: x
on: [push]
templates:
  build:
    params:
      node: { type: number }
      mode: { type: enum, values: [dev, prod] }
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "{{ args.node }}"
      - run: build --mode {{ args.mode }}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: build
        with: { node: 20, mode: prod }
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps).toEqual([
      { uses: "actions/setup-node@v4", with: { "node-version": "20" } },
      { run: "build --mode prod" },
    ]);
  });

  it("nests a fragment inside a template and a template inside a fragment", () => {
    const { doc, errors } = build(`name: x
on: [push]
fragments:
  setup:
    - uses: actions/checkout@v4
  outer:
    - inject: greet
      with: { who: world }
    - run: tail
templates:
  greet:
    params:
      who: { type: string }
    steps:
      - inject: setup
      - run: hi {{ args.who }}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: outer
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps).toEqual([
      { uses: "actions/checkout@v4" },
      { run: "hi world" },
      { run: "tail" },
    ]);
  });

  it("never inspects a real uses: step (uses + with, no inject, left verbatim)", () => {
    const { doc, errors } = build(`name: x
on: [push]
templates:
  greet:
    params:
      who: { type: string }
    steps:
      - run: hi {{ args.who }}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - inject: greet
        with: { who: world }
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps).toEqual([
      { uses: "actions/setup-node@v4", with: { "node-version": "20" } },
      { run: "hi world" },
    ]);
  });

  it("preserves ${{ }} runtime expressions verbatim while erasing {{ args.* }}", () => {
    const { doc, errors } = build(`name: x
on: [push]
templates:
  greet:
    params:
      who: { type: string }
    steps:
      - run: echo "{{ args.who }} \${{ github.sha }}"
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: greet
        with: { who: world }
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps).toEqual([{ run: 'echo "world ${{ github.sha }}"' }]);
  });
});

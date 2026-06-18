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

  it("keeps inline strategy over dynamic_matrix while dynamic_matrix still overrides inherited defaults", () => {
    const { doc, errors } = build(`name: x
on: [push]
job_defaults:
  strategy:
    matrix:
      from_default: [a, b]
    fail-fast: true
jobs:
  inline_wins:
    runs-on: ubuntu-latest
    dynamic_matrix:
      script: echo '["x"]'
      alias: shard
    strategy:
      matrix:
        keep: [manual]
      fail-fast: true
    steps:
      - run: echo \${{ matrix.keep }}
  defaults_overridden:
    runs-on: ubuntu-latest
    dynamic_matrix:
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
    expect(doc.jobs.defaults_overridden.strategy).toEqual({
      matrix: { shard: "${{ fromJSON(needs.actio_setup_defaults_overridden.outputs.matrix) }}" },
      "fail-fast": true,
    });
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

  it("wraps a multi-line inline script in a group so the whole block feeds jq", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic_matrix:
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
    dynamic_matrix:
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
    dynamic_matrix:
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
    dynamic_matrix:
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
    dynamic_matrix:
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
    dynamic_matrix:
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

describe("job_defaults + executors", () => {
  it("partitions uses jobs and reports skipped runner defaults", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
job_defaults:
  if: \${{ github.ref == 'refs/heads/main' }}
  permissions:
    contents: read
  concurrency:
    group: ci
  strategy:
    fail-fast: false
    matrix:
      shard: [a, b]
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
    expect(doc.jobs.call.strategy).toEqual({
      "fail-fast": false,
      matrix: { shard: ["a", "b"] },
    });
    expect(doc.jobs.test.strategy).toEqual({
      "fail-fast": false,
      matrix: { shard: ["a", "b"] },
    });

    const infos = result.diagnostics.filter((d) => d.severity === "info");
    expect(infos.some((d) => d.message.includes("job-defaults-uses-skipped"))).toBe(true);
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

  it("errors when job_defaults or executors are not mappings", () => {
    const { result, errors } = build(`name: x
on: [push]
job_defaults: bad
executors: bad
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(false);
    expect(errors.some((d) => d.message.includes('"job_defaults" must be a mapping'))).toBe(true);
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
job_defaults:
  timeout-minutes: 11
  env:
    CI: "true"
executors:
  hardened:
    permissions:
      contents: read
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
      hardened: { permissions: { contents: "read" } },
    });
    expect(ctx.data.job_defaults).toBeUndefined();
    expect(ctx.data.executors).toBeUndefined();

    const emitted = parse(transpile(source, { fileName: "t.actio.yml" }).yaml);
    expect(emitted.job_defaults).toBeUndefined();
    expect(emitted.executors).toBeUndefined();

    const singleJob: Job = {
      "runs-on": "ubuntu-latest",
      steps: [{ run: "echo hi" }],
    };
    applyDefaults(singleJob, { "timeout-minutes": 22 });
    applyExecutor(singleJob, { permissions: { contents: "read" } });
    expect(singleJob["timeout-minutes"]).toBe(22);
    expect(singleJob.permissions).toEqual({ contents: "read" });

    const blankIfJob: Job = { if: "" };
    applyDefaults(blankIfJob, { if: "" });
    expect(blankIfJob.if).toBeUndefined();
    expect(Object.hasOwn(blankIfJob, "if")).toBe(false);
  });

  it("AND-combines wrapped expressions without mangling runtime syntax", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
job_defaults:
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
job_defaults:
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

  it("composes executor arrays left-to-right and keeps job inline keys authoritative", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
executors:
  hardened:
    permissions:
      contents: read
    timeout-minutes: 10
  gpu:
    runs-on: [self-hosted, gpu]
    container:
      image: nvidia/cuda:12.4.0-base
  fast:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    timeout-minutes: 5
jobs:
  release:
    executor: [hardened, gpu]
    steps:
      - run: echo release
  tuned:
    executor: [hardened, fast]
    permissions:
      pull-requests: write
    steps:
      - run: echo tuned
`);
    expect(result.ok).toBe(true);
    expect(errors).toEqual([]);
    expect(doc.jobs.release.permissions).toEqual({ contents: "read" });
    expect(doc.jobs.release["timeout-minutes"]).toBe(10);
    expect(doc.jobs.release["runs-on"]).toEqual(["self-hosted", "gpu"]);
    expect(doc.jobs.release.container).toEqual({ image: "nvidia/cuda:12.4.0-base" });

    expect(doc.jobs.tuned.permissions).toEqual({ "pull-requests": "write" });
    expect(doc.jobs.tuned["timeout-minutes"]).toBe(5);
    expect(doc.jobs.tuned["runs-on"]).toBe("ubuntu-latest");
  });

  it("replaces runs-on objects for REPLACE_KEYS across executor compose and apply", () => {
    const { result, errors, doc } = build(`name: x
on: [push]
job_defaults:
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

  it("rejects structural keys in job_defaults", () => {
    const { result, errors } = build(`name: x
on: [push]
job_defaults:
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

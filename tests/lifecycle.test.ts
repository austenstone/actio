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

function hasCode(diags: { code?: string }[], code: string): boolean {
  return diags.some((d) => d.code === code);
}

const TWO_JOBS = `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [ { run: ./build.sh } ]
  test:
    runs-on: ubuntu-latest
    needs: [build]
    steps: [ { run: ./test.sh } ]
`;

// ---------------------------------------------------------------------------
// finally: workflow-scoped teardown
// ---------------------------------------------------------------------------

describe("finally: bare → two-job split", () => {
  it("emits a !cancelled() aggregator and a cancelled() companion with timeout", () => {
    const { result, errors, doc } = build(`${TWO_JOBS}finally:
  teardown:
    runs-on: ubuntu-latest
    steps:
      - run: ./destroy.sh
`);
    expect(result.ok).toBe(true);
    expect(errors).toEqual([]);
    expect(doc.finally).toBeUndefined();
    expect(result.yaml).not.toContain("finally");

    expect(doc.jobs.teardown.needs).toEqual(["build", "test"]);
    expect(doc.jobs.teardown.if).toBe("!cancelled()");
    expect(doc.jobs.teardown.steps).toEqual([{ run: "./destroy.sh" }]);
    expect(doc.jobs.teardown["timeout-minutes"]).toBeUndefined();

    const cancel = doc.jobs["teardown-on-cancel"];
    expect(cancel.needs).toEqual(["build", "test"]);
    expect(cancel.if).toBe("cancelled()");
    expect(cancel["timeout-minutes"]).toBe(5);
    expect(cancel.steps).toEqual([{ run: "./destroy.sh" }]);
  });
});

describe("finally: on_abort 3-state", () => {
  it("absent → auto cancel companion re-runs the body", () => {
    const { doc } = build(`${TWO_JOBS}finally:
  teardown:
    runs-on: ubuntu-latest
    steps: [ { run: ./stop.sh } ]
`);
    expect(doc.jobs["teardown-on-cancel"]).toBeDefined();
    expect(doc.jobs["teardown-on-cancel"].if).toBe("cancelled()");
  });

  it("present non-empty → replaces companion, no auto companion emitted", () => {
    const { doc, errors } = build(`${TWO_JOBS}finally:
  teardown:
    runs-on: ubuntu-latest
    steps: [ { run: ./stop.sh } ]
  on_abort:
    teardown-cancelled:
      runs-on: ubuntu-latest
      steps:
        - run: ./stop.sh
        - run: ./notify.sh
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.teardown.if).toBe("!cancelled()");
    expect(doc.jobs["teardown-on-cancel"]).toBeUndefined();
    const c = doc.jobs["teardown-cancelled"];
    expect(c.if).toBe("cancelled()");
    expect(c["timeout-minutes"]).toBe(5);
    expect(c.needs).toEqual(["build", "test"]);
    expect(c.steps).toEqual([{ run: "./stop.sh" }, { run: "./notify.sh" }]);
  });

  it("present empty (on_abort: []) → no cancel job at all", () => {
    const { doc, errors } = build(`${TWO_JOBS}finally:
  teardown:
    runs-on: ubuntu-latest
    steps: [ { run: ./stop.sh } ]
  on_abort: []
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.teardown.if).toBe("!cancelled()");
    expect(doc.jobs["teardown-on-cancel"]).toBeUndefined();
    expect(Object.keys(doc.jobs).filter((k) => k.includes("cancel"))).toEqual([]);
  });
});

describe("finally: outcome branches at job scope", () => {
  it("lowers on_success/on_failure/on_abort to status guards", () => {
    const { doc, errors } = build(`${TWO_JOBS}finally:
  on_success:
    notify-shipped:
      runs-on: ubuntu-latest
      steps: [ { run: ./notify.sh } ]
  on_failure:
    page-oncall:
      runs-on: ubuntu-latest
      steps: [ { run: ./page.sh } ]
  on_abort:
    release-locks:
      runs-on: ubuntu-latest
      steps: [ { run: ./release.sh } ]
`);
    expect(errors).toEqual([]);
    expect(doc.jobs["notify-shipped"].if).toBe("success()");
    expect(doc.jobs["notify-shipped"].needs).toEqual(["build", "test"]);
    expect(doc.jobs["page-oncall"].if).toBe("failure()");
    expect(doc.jobs["release-locks"].if).toBe("cancelled()");
    expect(doc.jobs["release-locks"]["timeout-minutes"]).toBe(5);
    // on_abort present → no auto companion for any unconditional job (none here)
    expect(doc.jobs["teardown-on-cancel"]).toBeUndefined();
  });
});

describe("finally: when sugar → needs.<job>.result", () => {
  it("expands deploy.failed and force-adds deploy to needs", () => {
    const { doc, errors } = build(`name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [ { run: ./build.sh } ]
  deploy:
    runs-on: ubuntu-latest
    needs: [build]
    steps: [ { run: ./deploy.sh } ]
finally:
  on_failure:
    triage:
      runs-on: ubuntu-latest
      when: deploy.failed
      steps: [ { run: ./triage.sh } ]
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.triage.if).toBe("failure() && needs.deploy.result == 'failure'");
    expect(doc.jobs.triage.needs).toEqual(["build", "deploy"]);
    expect(doc.jobs.triage.when).toBeUndefined();
  });
});

describe("finally: auto-needs over multiplied jobs", () => {
  it("aggregates for_each clones, not the template", () => {
    const { doc, errors } = build(`name: ci
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
finally:
  teardown:
    runs-on: ubuntu-latest
    steps: [ { run: ./cleanup.sh } ]
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.teardown.needs).toEqual(["deploy-staging", "deploy-prod"]);
    expect(doc.jobs.teardown.needs).not.toContain("deploy");
  });
});

// ---------------------------------------------------------------------------
// ensure / on_* step & job modifiers
// ---------------------------------------------------------------------------

describe("ensure: step modifier", () => {
  it("splices an always() guard step right after the guarded step", () => {
    const { doc, errors } = build(`name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./work.sh
        ensure:
          - run: ./cleanup.sh
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps).toEqual([
      { run: "./work.sh", id: "actio_a_step_1" },
      { run: "./cleanup.sh", if: "always()" },
    ]);
  });
});

describe("ensure: job modifier", () => {
  it("appends always() teardown steps to the end of the job", () => {
    const { doc, errors } = build(`name: ci
on: [push]
jobs:
  e2e:
    runs-on: ubuntu-latest
    ensure:
      - run: docker compose down -v
    steps:
      - run: docker compose up -d
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.e2e.steps).toEqual([
      { run: "docker compose up -d" },
      { run: "docker compose down -v", if: "always()" },
    ]);
    expect(doc.jobs.e2e.ensure).toBeUndefined();
  });
});

describe("step outcome-branch guards", () => {
  it("keys on outcome for on_failure / on_success", () => {
    const { doc, errors } = build(`name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        run: ./deploy.sh
        on_failure:
          - run: ./rollback.sh
        on_success:
          - run: ./smoke-test.sh
`);
    expect(errors).toEqual([]);
    const steps = doc.jobs.a.steps;
    expect(steps[0]).toEqual({ name: "Deploy", run: "./deploy.sh", id: "step_deploy" });
    expect(steps[1]).toEqual({
      run: "./rollback.sh",
      if: "!cancelled() && steps.step_deploy.outcome == 'failure'",
    });
    expect(steps[2]).toEqual({
      run: "./smoke-test.sh",
      if: "success() && steps.step_deploy.outcome == 'success'",
    });
  });
});

describe("job-level outcome branches", () => {
  it("appends failure()/success() teardown steps", () => {
    const { doc, errors } = build(`name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    on_failure:
      - run: ./alert.sh
    steps:
      - run: ./main.sh
`);
    expect(errors).toEqual([]);
    expect(doc.jobs.a.steps).toEqual([
      { run: "./main.sh" },
      { run: "./alert.sh", if: "failure()" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// §5 error table
// ---------------------------------------------------------------------------

describe("lifecycle §5 errors", () => {
  it("#1 finally not a mapping", () => {
    const { result } = build(`${TWO_JOBS}finally: nope
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, "lifecycle-finally-not-mapping")).toBe(true);
  });

  it("#2 finally job collides with an existing job", () => {
    const { result } = build(`${TWO_JOBS}finally:
  build:
    runs-on: ubuntu-latest
    steps: [ { run: ./x.sh } ]
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, "lifecycle-job-collision")).toBe(true);
  });

  it("#3 when references an undefined job", () => {
    const { result } = build(`${TWO_JOBS}finally:
  on_failure:
    triage:
      runs-on: ubuntu-latest
      when: ghost.failed
      steps: [ { run: ./x.sh } ]
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, "lifecycle-when-unknown-job")).toBe(true);
  });

  it("#4 when uses an unknown state", () => {
    const { result } = build(`${TWO_JOBS}finally:
  on_failure:
    triage:
      runs-on: ubuntu-latest
      when: build.exploded
      steps: [ { run: ./x.sh } ]
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, "lifecycle-when-unknown-state")).toBe(true);
  });

  it("#5 hook value is not a list of steps", () => {
    const { result } = build(`name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./work.sh
        on_failure:
          rollback:
            runs-on: ubuntu-latest
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, "lifecycle-hook-not-steps")).toBe(true);
  });

  it("#6 step-level on_abort warns", () => {
    const { warnings } = build(`name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./work.sh
        on_abort:
          - run: ./bail.sh
`);
    expect(hasCode(warnings, "lifecycle-step-on-abort")).toBe(true);
  });

  it("#7 finally at job level errors and points to ensure", () => {
    const { result } = build(`name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    finally:
      - run: ./x.sh
    steps:
      - run: ./work.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, "lifecycle-finally-scope")).toBe(true);
  });

  it("#7 finally at step level errors", () => {
    const { result } = build(`name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./work.sh
        finally:
          - run: ./x.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, "lifecycle-finally-scope")).toBe(true);
  });

  it("#8 finally job needs a sibling finally job", () => {
    const { result } = build(`${TWO_JOBS}finally:
  first:
    runs-on: ubuntu-latest
    steps: [ { run: ./a.sh } ]
  second:
    runs-on: ubuntu-latest
    needs: [first]
    steps: [ { run: ./b.sh } ]
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, "lifecycle-finally-needs-sibling")).toBe(true);
  });

  it("#9 empty hook warns and is stripped", () => {
    const { warnings, doc } = build(`name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./work.sh
        ensure: []
`);
    expect(hasCode(warnings, "lifecycle-empty-hook")).toBe(true);
    expect(doc.jobs.a.steps[0].ensure).toBeUndefined();
  });

  it("#10 a hook nested inside a hook step errors", () => {
    const { result } = build(`name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./work.sh
        on_failure:
          - run: ./rollback.sh
            on_failure:
              - run: ./deeper.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, "lifecycle-hook-nesting")).toBe(true);
  });
});

describe("lifecycle: defensive edge cases", () => {
  it("warns and strips teardown hooks on a reusable-workflow (uses) job", () => {
    const { result, warnings, doc } = build(`name: ci
on: [push]
jobs:
  call:
    uses: ./.github/workflows/reusable.yml
    ensure:
      - run: ./cleanup.sh
`);
    expect(result.ok).toBe(true);
    expect(hasCode(warnings, "lifecycle-uses-job")).toBe(true);
    expect(doc.jobs.call.ensure).toBeUndefined();
  });

  it("errors when a finally job entry is not a mapping", () => {
    const { result } = build(`${TWO_JOBS}finally:
  teardown: ./not-a-job.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, "lifecycle-finally-not-mapping")).toBe(true);
  });

  it("errors when an outcome branch group is not a mapping", () => {
    const { result } = build(`${TWO_JOBS}finally:
  on_success: ./not-a-mapping.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result.diagnostics, "lifecycle-finally-not-mapping")).toBe(true);
  });
});

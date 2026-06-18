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

/** A diagnostic with the given structured `code` fired (lifecycle uses the code field). */
function hasCode(result: { diagnostics: { code?: string }[] }, code: string): boolean {
  return result.diagnostics.some((d) => d.code === code);
}

function jobsOf(doc: { jobs?: Record<string, unknown> }): Record<string, Record<string, unknown>> {
  return (doc?.jobs ?? {}) as Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// §5 compile errors (#1–#10) — one focused case each.
// ---------------------------------------------------------------------------

describe("lifecycle §5 errors", () => {
  it("#1 finally: that is not a mapping", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally: "nope"
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/finally-not-mapping")).toBe(true);
  });

  it("#2 finally job that collides with a real job key", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  teardown:
    runs-on: ubuntu-latest
    steps:
      - run: ./real.sh
finally:
  teardown:
    runs-on: ubuntu-latest
    steps:
      - run: ./cleanup.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/finally-collision")).toBe(true);
  });

  it("#3 when: that references an undefined job", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally:
  cleanup:
    runs-on: ubuntu-latest
    when: ghost.failed
    steps:
      - run: ./cleanup.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/when-job")).toBe(true);
  });

  it("#4 when: that uses an unknown state", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally:
  cleanup:
    runs-on: ubuntu-latest
    when: build.exploded
    steps:
      - run: ./cleanup.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/when-state")).toBe(true);
  });

  it("#5 ensure: with a non-list value", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        ensure: "nope"
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/hook-shape")).toBe(true);
  });

  it("#6 (warning) step-level on_abort", () => {
    const { result, warnings } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        on_abort:
          - run: ./local-cleanup.sh
`);
    expect(result.ok).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
    expect(hasCode(result, "lifecycle/step-on-abort")).toBe(true);
  });

  it("#7 finally: at job scope", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    finally:
      teardown:
        runs-on: ubuntu-latest
        steps:
          - run: ./cleanup.sh
    steps:
      - run: ./deploy.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/finally-scope")).toBe(true);
  });

  it("#7 finally: at step scope", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        finally:
          - run: ./cleanup.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/finally-scope")).toBe(true);
  });

  it("#8 finally job that needs a sibling finally job", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally:
  release-locks:
    runs-on: ubuntu-latest
    steps:
      - run: ./release.sh
  notify:
    runs-on: ubuntu-latest
    needs: [release-locks]
    steps:
      - run: ./notify.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/finally-needs-sibling")).toBe(true);
  });

  it("#9 (warning) empty ensure: is stripped", () => {
    const { result, warnings, doc } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        ensure: []
`);
    expect(result.ok).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
    expect(hasCode(result, "lifecycle/empty-hook")).toBe(true);
    expect(result.yaml).not.toContain("ensure");
    const steps = jobsOf(doc).deploy.steps as unknown[];
    expect(steps).toHaveLength(1);
  });

  it("#10 a hook nested inside a hook", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        on_failure:
          - run: ./rollback.sh
            on_failure:
              - run: ./panic.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/nested-hook")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behavioral guarantees beyond the golden fixtures.
// ---------------------------------------------------------------------------

describe("lifecycle behavior", () => {
  it("a bare finally: emits the normal aggregator plus a cancel companion", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally:
  teardown:
    runs-on: ubuntu-latest
    steps:
      - run: ./cleanup.sh
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc);
    expect(jobs.teardown.if).toBe("${{ !cancelled() }}");
    expect(jobs["teardown-on-cancel"].if).toBe("${{ cancelled() }}");
    expect(jobs["teardown-on-cancel"]["timeout-minutes"]).toBe(5);
    expect(jobs.teardown.needs).toEqual(["build"]);
    expect(jobs["teardown-on-cancel"].needs).toEqual(["build"]);
  });

  it("on_abort: [] keeps the normal teardown but emits no cancel job", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally:
  teardown:
    runs-on: ubuntu-latest
    steps:
      - run: ./cleanup.sh
  on_abort: []
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc);
    expect(jobs.teardown.if).toBe("${{ !cancelled() }}");
    expect(Object.keys(jobs)).not.toContain("teardown-on-cancel");
    expect(result.yaml).not.toContain("${{ cancelled() }}");
  });

  it("a non-empty on_abort: replaces the cancel companion body", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally:
  teardown:
    runs-on: ubuntu-latest
    steps:
      - run: ./cleanup.sh
  on_abort:
    teardown-cancelled:
      runs-on: ubuntu-latest
      steps:
        - run: ./cleanup.sh
        - run: ./notify.sh cancelled
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc);
    expect(Object.keys(jobs)).not.toContain("teardown-on-cancel");
    expect(jobs["teardown-cancelled"].if).toBe("${{ cancelled() }}");
    expect((jobs["teardown-cancelled"].steps as unknown[]).length).toBe(2);
  });

  it("finally jobs do not depend on one another (auto-needs is only real jobs)", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./a.sh
  b:
    runs-on: ubuntu-latest
    steps:
      - run: ./b.sh
`);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc);
    expect(jobs.a.needs).toEqual(["build"]);
    expect(jobs.b.needs).toEqual(["build"]);
  });

  it("a step on_success keys on outcome and the step gains an id", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Ship
        run: ./ship.sh
        on_success:
          - run: ./smoke.sh
`);
    expect(result.ok).toBe(true);
    const steps = jobsOf(doc).deploy.steps as Record<string, unknown>[];
    expect(steps[0].id).toBe("step_ship");
    expect(steps[1].if).toBe("${{ success() && steps.step_ship.outcome == 'success' }}");
  });

  it("a job uses: with a lifecycle hook warns and skips the hook", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  call:
    uses: ./.github/workflows/x.yml
    ensure:
      - run: ./cleanup.sh
`);
    expect(hasCode(result, "lifecycle/uses-job-hook")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Additional branch coverage: job-scope hook shapes, when sugar edge cases,
// finally-job and branch-group shapes, and job on_success/on_abort guards.
// ---------------------------------------------------------------------------

describe("lifecycle branch coverage", () => {
  it("a job-level hook that is not a list errors with hook-shape", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    on_failure: nope
    steps:
      - run: ./build.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/hook-shape")).toBe(true);
  });

  it("an empty job-level hook warns and is stripped", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    ensure: []
    steps:
      - run: ./build.sh
`);
    expect(result.ok).toBe(true);
    expect(hasCode(result, "lifecycle/empty-hook")).toBe(true);
    expect("ensure" in jobsOf(doc).build).toBe(false);
  });

  it("a nested hook inside a job-level hook errors", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    ensure:
      - run: ./cleanup.sh
        ensure:
          - run: ./inner.sh
    steps:
      - run: ./build.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/nested-hook")).toBe(true);
  });

  it("job-level on_success and on_abort hooks key on success() and cancelled()", () => {
    const { result, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    on_success:
      - run: ./publish.sh
    on_abort:
      - run: ./abort.sh
    steps:
      - run: ./build.sh
`);
    expect(result.ok).toBe(true);
    const steps = jobsOf(doc).build.steps as Record<string, unknown>[];
    const guards = steps.map((s) => s.if);
    expect(guards).toContain("${{ success() }}");
    expect(guards).toContain("${{ cancelled() }}");
  });

  it("a when: that is not a string errors with when-shape", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
finally:
  teardown:
    runs-on: ubuntu-latest
    when: 123
    steps:
      - run: ./cleanup.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/when-shape")).toBe(true);
  });

  it("a when: without a state suffix errors with when-state", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
finally:
  teardown:
    runs-on: ubuntu-latest
    when: deploy
    steps:
      - run: ./cleanup.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/when-state")).toBe(true);
  });

  it("a direct finally job that is not a mapping errors with finally-job-shape", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally:
  teardown: "nope"
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/finally-job-shape")).toBe(true);
  });

  it("an outcome branch group that is not a mapping errors with branch-shape", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally:
  on_failure: "nope"
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/branch-shape")).toBe(true);
  });

  it("a non-empty array branch group errors with branch-shape", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally:
  on_abort:
    - run: ./cleanup.sh
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/branch-shape")).toBe(true);
  });

  it("a branch-group job that is not a mapping errors with finally-job-shape", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./build.sh
finally:
  on_failure:
    rollback: "nope"
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "lifecycle/finally-job-shape")).toBe(true);
  });
});

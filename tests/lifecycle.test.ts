import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";

interface Diag {
  severity: string;
  message: string;
  code?: string;
  range?: unknown;
}

function diag(source: string): { errors: Diag[]; warnings: Diag[] } {
  const result = transpile(source, { fileName: "t.actio.yml" });
  const diags = result.diagnostics as Diag[];
  return {
    errors: diags.filter((d) => d.severity === "error"),
    warnings: diags.filter((d) => d.severity === "warning"),
  };
}

function yamlOf(source: string): string {
  return transpile(source, { fileName: "t.actio.yml" }).yaml;
}

/** Assert a diagnostic with the given code exists, matches the message, and carries a range. */
function expectDiag(diags: Diag[], code: string, re: RegExp): Diag {
  const hit = diags.find((d) => d.code === code);
  expect(hit, `expected a diagnostic with code ${code}`).toBeTruthy();
  const d = hit as Diag;
  expect(d.message).toMatch(re);
  expect(d.range, `diagnostic ${code} should carry a source range`).toBeTruthy();
  return d;
}

describe("lifecycle §5 diagnostics", () => {
  it("#1 finally must be a mapping", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./b.sh
finally: ./teardown.sh
`);
    expectDiag(errors, "finally-not-mapping", /finally must be a mapping/);
  });

  it("#2 finally job collides with a real job", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./b.sh
finally:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./t.sh
`);
    expectDiag(errors, "finally-job-collision", /collides with a job of the same name/);
  });

  it("#3 when: references an unknown job", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./d.sh
finally:
  on-failure:
    rollback:
      runs-on: ubuntu-latest
      when: ghost.failed
      steps:
        - run: ./r.sh
`);
    expectDiag(errors, "when-unknown-job", /Unknown job "ghost" in when:/);
  });

  it("#4 when: uses an unknown outcome", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./d.sh
finally:
  on-failure:
    rollback:
      runs-on: ubuntu-latest
      when: deploy.exploded
      steps:
        - run: ./r.sh
`);
    expectDiag(errors, "when-unknown-state", /Unknown outcome "exploded"/);
  });

  it("#5 hook value is not a step list", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        ensure: "not a list"
`);
    expectDiag(errors, "hook-not-step-list", /ensure must be a list of steps/);
  });

  it("#6 step-level on-abort warns", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        on-abort:
          - run: ./cleanup.sh
`);
    expectDiag(warnings, "step-on-abort", /step-level on-abort only sees step cancellation/);
  });

  it("#7 finally at job scope is an error suggesting ensure", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    finally:
      cleanup:
        runs-on: ubuntu-latest
        steps:
          - run: ./c.sh
    steps:
      - run: ./x.sh
`);
    const d = expectDiag(errors, "finally-wrong-scope", /workflow-scoped; use ensure:/);
    expect(d.message).toContain("ensure:");
  });

  it("#7 finally at step scope is an error suggesting ensure", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        finally:
          - run: ./c.sh
`);
    expectDiag(errors, "finally-wrong-scope", /workflow-scoped; use ensure:/);
  });

  it("#8 finally jobs cannot depend on each other", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./d.sh
finally:
  first:
    runs-on: ubuntu-latest
    steps:
      - run: ./a.sh
  second:
    runs-on: ubuntu-latest
    needs: [first]
    steps:
      - run: ./b.sh
`);
    expectDiag(errors, "finally-needs-sibling", /cannot depend on each other/);
  });

  it("#9 empty ensure warns", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
        ensure: []
`);
    expectDiag(warnings, "empty-ensure", /empty ensure: has no effect/);
  });

  it("#10 lifecycle hooks cannot nest", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        on-failure:
          - run: ./rollback.sh
            ensure:
              - run: ./log.sh
`);
    expectDiag(errors, "hook-nesting", /lifecycle hooks cannot nest/);
  });
});

describe("lifecycle guards & job-scope branches", () => {
  it("emits an outcome-keyed guard for a step-level on-success hook", () => {
    const yaml = yamlOf(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: build
        run: ./build.sh
        on-success:
          - run: ./notify.sh
`);
    expect(yaml).toContain("steps.build.outcome == 'success'");
    expect(yaml).toContain("success() && steps.build.outcome == 'success'");
  });

  it("appends job-level outcome + ensure teardown steps with success/failure/cancel/always guards", () => {
    const yaml = yamlOf(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./main.sh
    on-success:
      - run: ./ok.sh
    on-failure:
      - run: ./bad.sh
    on-abort:
      - run: ./cancel.sh
    ensure:
      - run: ./always.sh
`);
    expect(yaml).toContain("if: success()");
    expect(yaml).toContain("if: failure()");
    expect(yaml).toContain("if: cancelled()");
    expect(yaml).toContain("if: always()");
  });

  it("errors when a job-scope hook value is not a step list", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
    ensure: "not a list"
`);
    expectDiag(errors, "hook-not-step-list", /ensure must be a list of steps/);
  });

  it("warns on an empty job-scope ensure", () => {
    const { warnings } = diag(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./x.sh
    ensure: []
`);
    expectDiag(warnings, "empty-ensure", /empty ensure: has no effect/);
  });
});

describe("lifecycle finally edge diagnostics", () => {
  it("errors when when: is not a string", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./d.sh
finally:
  on-failure:
    rollback:
      runs-on: ubuntu-latest
      when:
        - deploy.failed
      steps:
        - run: ./r.sh
`);
    expectDiag(errors, "when-unknown-state", /Unknown outcome/);
  });

  it("errors when a named finally job body is not a mapping", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./b.sh
finally:
  cleanup: ./teardown.sh
`);
    expectDiag(errors, "finally-not-mapping", /finally must be a mapping/);
  });

  it("errors when a branch group is a non-empty list", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./b.sh
finally:
  on-failure:
    - run: ./oops.sh
`);
    expectDiag(errors, "finally-not-mapping", /finally must be a mapping/);
  });

  it("errors when a branch group is a scalar", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./b.sh
finally:
  on-failure: ./oops.sh
`);
    expectDiag(errors, "finally-not-mapping", /finally must be a mapping/);
  });

  it("errors when a branch-group job body is not a mapping", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./b.sh
finally:
  on-failure:
    rollback: ./r.sh
`);
    expectDiag(errors, "finally-not-mapping", /finally must be a mapping/);
  });

  it("errors when a branch-group job collides with a real job", () => {
    const { errors } = diag(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: ./b.sh
finally:
  on-failure:
    build:
      runs-on: ubuntu-latest
      steps:
        - run: ./r.sh
`);
    expectDiag(errors, "finally-job-collision", /collides with a job of the same name/);
  });
});

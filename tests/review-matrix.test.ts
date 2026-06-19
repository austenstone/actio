import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Transpile and parse the generated YAML back to a JS object for assertions. */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml" });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  return { result, errors, doc: result.ok ? parse(result.yaml) : undefined };
}

describe("review W3: dynamic-matrix setupId collision guard", () => {
  it("errors when dynamic-matrix.id collides with another job id instead of silently dropping the setup job", () => {
    // The generated setup job id (`shared`) collides with a real job also named
    // `shared`. Without a guard the plain-object rebuild overwrites one with the
    // other, the setup job vanishes, and `build` dangles on needs.shared.
    const { errors } = build(`name: x
on: [push]
jobs:
  shared:
    runs-on: ubuntu-latest
    steps:
      - run: echo real
  build:
    runs-on: ubuntu-latest
    dynamic-matrix:
      id: shared
      script: echo "[1,2,3]"
    steps:
      - run: echo \${{ matrix.value }}`);

    const collision = errors.find((d) => /dynamic-matrix.*id|\bid\b.*collid/i.test(d.message));
    expect(collision, "expected an error diagnostic naming the colliding id").toBeDefined();
    expect(collision?.message).toContain("shared");
  });

  it("errors when dynamic-matrix.id equals the consuming job's own id (needs-self cycle)", () => {
    const { errors } = build(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    dynamic-matrix:
      id: build
      script: echo "[1,2,3]"
    steps:
      - run: echo \${{ matrix.value }}`);

    const collision = errors.find((d) => d.message.includes("build"));
    expect(collision, "expected an error diagnostic for self-collision").toBeDefined();
  });

  it("errors when two different dynamic-matrix jobs resolve to the same generated setupId", () => {
    // Both jobs request the same explicit setup id. The first generates
    // `shared` fine (no original job owns it); without a generated-id guard the
    // second's `rebuilt["shared"] = setup` silently overwrites the first setup
    // job, so job `a` dangles on needs.shared. The guard must catch the second.
    const { errors } = build(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    dynamic-matrix:
      id: shared
      script: echo "[1,2,3]"
    steps:
      - run: echo \${{ matrix.value }}
  b:
    runs-on: ubuntu-latest
    dynamic-matrix:
      id: shared
      script: echo "[4,5,6]"
    steps:
      - run: echo \${{ matrix.value }}`);

    const collision = errors.find((d) => /another generated setup job|collid/i.test(d.message));
    expect(
      collision,
      "expected an error when a second dynamic-matrix reuses an already-generated setupId",
    ).toBeDefined();
    expect(collision?.message).toContain("shared");
  });

  it("on collision leaves the input job untouched rather than emitting a broken workflow", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  shared:
    runs-on: ubuntu-latest
    steps:
      - run: echo real
  build:
    runs-on: ubuntu-latest
    dynamic-matrix:
      id: shared
      script: echo "[1,2,3]"
    steps:
      - run: echo \${{ matrix.value }}`);

    // If output is still schema-valid, it must NOT reference the dropped setup job.
    if (doc) {
      const buildJob = doc.jobs?.build;
      const needs = buildJob?.needs == null ? [] : [].concat(buildJob.needs);
      expect(needs).not.toContain("shared");
    }
  });

  it("still splits normally when dynamic-matrix.id is unique", () => {
    const { doc, errors } = build(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    dynamic-matrix:
      id: gen_matrix
      script: echo "[1,2,3]"
    steps:
      - run: echo \${{ matrix.value }}`);

    expect(errors).toEqual([]);
    expect(doc?.jobs?.gen_matrix).toBeDefined();
    const needs = doc?.jobs?.build?.needs == null ? [] : [].concat(doc.jobs.build.needs);
    expect(needs).toContain("gen_matrix");
  });
});

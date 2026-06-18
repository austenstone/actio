import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Post-merge edge-case review for the retry pass.
 * - B2: a `retry:` step that carries a user `id` reclaims that id onto the
 *   FINAL attempt, which only runs when an earlier attempt failed. On the
 *   common first-attempt-success path the reclaimed-id step is skipped, so
 *   downstream `steps.<id>.outputs`/`.outcome` read empty. The transpiler must
 *   warn about this silent-corruption hazard.
 * - W4: synthesized `${base}_attempt_${n}` ids must never collide with the
 *   reserved user id, otherwise the final reclaim produces duplicate step ids.
 */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml", validate: true });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  return { result, errors, warnings, doc: result.ok ? parse(result.yaml) : undefined };
}

describe("REVIEW B2: retry with a user id warns about unreliable downstream refs", () => {
  it("emits a warning referencing the outputs/outcome caveat", () => {
    const { result, errors, warnings } = build(`on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - id: gen
        run: echo "v=1" >> $GITHUB_OUTPUT
        retry: 3
      - run: echo "\${{ steps.gen.outputs.v }}"
`);
    expect(result.ok).toBe(true);
    expect(errors).toEqual([]);
    const hit = warnings.find(
      (d) => /\bgen\b/.test(d.message) && /outputs|outcome/.test(d.message),
    );
    expect(hit, "expected a warning about steps.<id>.outputs/.outcome reliability").toBeDefined();
  });
});

describe("REVIEW W4: synthesized retry ids never collide with the reserved id", () => {
  it("produces all-distinct step ids when the user id matches an attempt name", () => {
    const { errors, doc } = build(`on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Foo
        id: step_foo_attempt_1
        run: echo hi
        retry: 3
`);
    expect(errors).toEqual([]);
    const ids = doc.jobs.j.steps
      .map((s: { id?: string }) => s.id)
      .filter((id: string | undefined): id is string => Boolean(id));
    expect(ids).toContain("step_foo_attempt_1");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

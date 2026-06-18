import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { isMap, type Node, parseDocument } from "yaml";

/**
 * Transpile with GitHub's official workflow-parser validation enabled, and
 * expose helpers for asserting passthrough fidelity of legal GHA YAML.
 */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml", validate: true });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  return { result, errors, yaml: result.yaml };
}

/**
 * Return the ordered list of mapping keys at the given path in a YAML document,
 * using the order-preserving CST (NOT toJS, which silently reorders keys).
 */
function keyOrder(yaml: string, path: Array<string | number>): string[] {
  let node = parseDocument(yaml).contents as Node | null;
  for (const seg of path) {
    if (node == null || typeof (node as { get?: unknown }).get !== "function") {
      throw new Error(`cannot descend into ${JSON.stringify(path)}`);
    }
    node = (node as { get(k: string | number, keep: boolean): Node }).get(seg, true);
  }
  if (!isMap(node)) throw new Error(`not a map at ${JSON.stringify(path)}`);
  return node.items.map((it) => String((it.key as { value?: unknown }).value ?? it.key));
}

describe("passthrough: mapping key order fidelity", () => {
  // actio round-trips the document through doc.toJS() (parser.ts), which yields a
  // plain JS object. JS objects reorder integer-like keys ("2", "10") to the front
  // in ascending numeric order, ahead of all string keys. Faithful passthrough must
  // preserve the author's mapping key order for legal GHA YAML.
  it("preserves top-level env key order when integer-like keys are present", () => {
    const source = `name: x
on: push
env:
  ALPHA: a
  '10': ten
  BETA: b
  '2': two
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const { errors, yaml } = build(source);
    expect(errors).toEqual([]);
    expect(keyOrder(yaml, ["env"])).toEqual(keyOrder(source, ["env"]));
  });

  it("preserves step `with` input order when integer-like keys are present", () => {
    const source = `name: x
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: foo/bar@v1
        with:
          name: Bob
          '1': first
          other: val
`;
    const { errors, yaml } = build(source);
    expect(errors).toEqual([]);
    expect(keyOrder(yaml, ["jobs", "a", "steps", 0, "with"])).toEqual(
      keyOrder(source, ["jobs", "a", "steps", 0, "with"]),
    );
  });
});

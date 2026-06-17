import { describe, expect, it } from "vitest";
import {
  combineIf,
  looksLikePath,
  mergeNeeds,
  slugify,
} from "../packages/core/src/passes/helpers.js";

describe("combineIf", () => {
  it("returns a single condition unchanged", () => {
    expect(combineIf("failure()")).toBe("failure()");
  });
  it("drops empty conditions", () => {
    expect(combineIf("failure()", undefined, "")).toBe("failure()");
  });
  it("strips ${{ }} wrappers before joining", () => {
    expect(combineIf("${{ success() }}", "env.X == '1'")).toBe("success() && env.X == '1'");
  });
  it("parenthesizes operands containing ||", () => {
    expect(combineIf("failure()", "a || b")).toBe("failure() && (a || b)");
  });
  it("leaves a condition with multiple ${{ }} wrappers intact (no corruption)", () => {
    // A lazy single-wrapper regex would span the interior delimiters and mangle
    // this into `github.event_name == 'push' }} && ${{ success()`.
    const multi = "${{ github.event_name == 'push' }} && ${{ success() }}";
    expect(combineIf(multi)).toBe(multi);
  });
});

describe("looksLikePath", () => {
  it("treats ./ ../ / ~/ prefixes and script extensions as paths", () => {
    expect(looksLikePath("./scripts/list.sh")).toBe(true);
    expect(looksLikePath("../gen.js")).toBe(true);
    expect(looksLikePath("/usr/local/bin/x")).toBe(true);
    expect(looksLikePath("gen.py")).toBe(true);
  });
  it("treats inline shell as not a path", () => {
    expect(looksLikePath("echo '[\"a\"]'")).toBe(false);
    expect(looksLikePath("node -e 'x'")).toBe(false);
    expect(looksLikePath("cat foo | jq .")).toBe(false);
  });
});

describe("mergeNeeds", () => {
  it("normalizes a string to an array", () => {
    expect(mergeNeeds("a", ["b"])).toEqual(["a", "b"]);
  });
  it("unions without duplicates and preserves order", () => {
    expect(mergeNeeds(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
  it("handles missing existing needs", () => {
    expect(mergeNeeds(undefined, ["a"])).toEqual(["a"]);
  });
});

describe("slugify", () => {
  it("lowercases and collapses non-alphanumerics to underscores", () => {
    expect(slugify("Run Tests!")).toBe("run_tests");
    expect(slugify("  Build & Deploy  ")).toBe("build_deploy");
  });
});

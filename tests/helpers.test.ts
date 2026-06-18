import { describe, expect, it } from "vitest";
import { parseActio } from "../packages/core/src/index.js";
import type { ParseContext } from "../packages/core/src/parser.js";
import {
  combineIf,
  expectMapping,
  looksLikePath,
  mapFallbackSteps,
  mergeNeeds,
  slugify,
  warnUnknownKeys,
} from "../packages/core/src/passes/helpers.js";

function freshCtx(): ParseContext {
  const ctx = parseActio("name: x\non: push\njobs: {}\n", { fileName: "t.actio.yml" });
  ctx.diagnostics.length = 0;
  return ctx;
}

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

describe("expectMapping", () => {
  it("returns true and pushes nothing for an object", () => {
    const ctx = freshCtx();
    expect(expectMapping(ctx, { a: 1 }, ["params"], { message: "nope" })).toBe(true);
    expect(ctx.diagnostics).toHaveLength(0);
  });
  it("pushes an error diagnostic with code for a non-object", () => {
    const ctx = freshCtx();
    expect(
      expectMapping(ctx, "scalar", ["params"], { message: "must be a mapping", code: "x" }),
    ).toBe(false);
    expect(ctx.diagnostics).toHaveLength(1);
    expect(ctx.diagnostics[0]).toMatchObject({
      severity: "error",
      message: "must be a mapping",
      code: "x",
    });
  });
  it("honors an overridden severity", () => {
    const ctx = freshCtx();
    expectMapping(ctx, 1, ["params"], { message: "m", severity: "warning" });
    expect(ctx.diagnostics[0].severity).toBe("warning");
  });
});

describe("warnUnknownKeys", () => {
  it("returns [] and pushes nothing when all keys are allowed", () => {
    const ctx = freshCtx();
    const unknown = warnUnknownKeys(ctx, { a: 1, b: 2 }, new Set(["a", "b"]), ["p"], {
      severity: "error",
      message: (k) => k,
    });
    expect(unknown).toEqual([]);
    expect(ctx.diagnostics).toHaveLength(0);
  });
  it("reports each unknown key with a per-key message and code", () => {
    const ctx = freshCtx();
    const unknown = warnUnknownKeys(ctx, { a: 1, bad: 2, worse: 3 }, new Set(["a"]), ["p"], {
      severity: "error",
      message: (k) => `${k} is not allowed`,
      code: "unknown-key",
    });
    expect(unknown).toEqual(["bad", "worse"]);
    expect(ctx.diagnostics.map((d) => d.message)).toEqual([
      "bad is not allowed",
      "worse is not allowed",
    ]);
    expect(ctx.diagnostics.every((d) => d.code === "unknown-key")).toBe(true);
  });
});

describe("mapFallbackSteps", () => {
  const mark = (steps: { run: string }[]) => steps.map((s) => ({ ...s, run: `${s.run}!` }));

  it("maps a bare step-array fallback", () => {
    const container: { fallback?: unknown } = { fallback: [{ run: "a" }] };
    mapFallbackSteps(container, mark as never);
    expect(container.fallback).toEqual([{ run: "a!" }]);
  });
  it("maps the steps of a { steps; recover } fallback in place", () => {
    const container: { fallback?: unknown } = {
      fallback: { steps: [{ run: "a" }], recover: [{ run: "r" }] },
    };
    mapFallbackSteps(container, mark as never);
    expect(container.fallback).toEqual({ steps: [{ run: "a!" }], recover: [{ run: "r" }] });
  });
  it("is a no-op when there is no fallback", () => {
    const container: { fallback?: unknown } = {};
    mapFallbackSteps(container, mark as never);
    expect(container.fallback).toBeUndefined();
  });
});

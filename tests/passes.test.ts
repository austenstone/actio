import type { ParseContext } from "actio-core";
import { applyPasses, builtinPasses, type Pass, PassRegistry, sortPasses } from "actio-core";
import { describe, expect, it } from "vitest";

/** A no-op pass that records the order it ran in. */
function recorder(name: string, runsAfter: string[], log: string[]): Pass {
  return {
    name,
    runsAfter,
    apply: () => {
      log.push(name);
    },
  };
}

const fakeCtx = {} as ParseContext;

describe("sortPasses", () => {
  it("orders passes after their declared dependencies", () => {
    const log: string[] = [];
    const passes = [recorder("c", ["b"], log), recorder("a", [], log), recorder("b", ["a"], log)];
    expect(sortPasses(passes).map((p) => p.name)).toEqual(["a", "b", "c"]);
  });

  it("keeps input order for passes with no ordering constraint", () => {
    const log: string[] = [];
    const passes = [recorder("x", [], log), recorder("y", [], log)];
    expect(sortPasses(passes).map((p) => p.name)).toEqual(["x", "y"]);
  });

  it("ignores unknown runsAfter names so partial sets still sort", () => {
    const log: string[] = [];
    const passes = [recorder("only", ["missing"], log)];
    expect(sortPasses(passes).map((p) => p.name)).toEqual(["only"]);
  });

  it("throws on a dependency cycle", () => {
    const log: string[] = [];
    const passes = [recorder("a", ["b"], log), recorder("b", ["a"], log)];
    expect(() => sortPasses(passes)).toThrow(/cycle/i);
  });

  it("resolves the built-in pipeline to the documented order", () => {
    expect(sortPasses(builtinPasses).map((p) => p.name)).toEqual([
      "params",
      "fragments",
      "retry",
      "fallback",
      "dynamic_matrix",
    ]);
  });
});

describe("applyPasses", () => {
  it("runs passes in dependency order", () => {
    const log: string[] = [];
    applyPasses(fakeCtx, [recorder("second", ["first"], log), recorder("first", [], log)]);
    expect(log).toEqual(["first", "second"]);
  });
});

describe("PassRegistry", () => {
  it("lets you add a pass and runs it in dependency order", () => {
    const log: string[] = [];
    const registry = new PassRegistry(builtinPasses);
    registry.register(recorder("post", ["dynamic_matrix"], log));
    expect(registry.list().map((p) => p.name)).toEqual([
      "params",
      "fragments",
      "retry",
      "fallback",
      "dynamic_matrix",
      "post",
    ]);
  });

  it("rejects duplicate pass names", () => {
    const log: string[] = [];
    const registry = new PassRegistry([recorder("dup", [], log)]);
    expect(() => registry.register(recorder("dup", [], log))).toThrow(/already registered/);
  });

  it("removes a pass by name", () => {
    const log: string[] = [];
    const registry = new PassRegistry([recorder("temp", [], log)]);
    expect(registry.has("temp")).toBe(true);
    expect(registry.unregister("temp")).toBe(true);
    expect(registry.has("temp")).toBe(false);
  });
});

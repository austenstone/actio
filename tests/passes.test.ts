import type { ParseContext } from "actio-core";
import {
  applyPasses,
  builtinPasses,
  createRegistry,
  type Pass,
  PassRegistry,
  sortPasses,
} from "actio-core";
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

  it("declares explicit dependencies for fragments", () => {
    const fragmentsPass = builtinPasses.find((pass) => pass.name === "fragments");
    expect(fragmentsPass?.runsAfter ?? []).toContain("params");
    expect(fragmentsPass?.runsAfter ?? []).toContain("when_compile");
  });

  it("enforces when_compile before fragments from metadata even with shuffled input", () => {
    const byName = new Map(builtinPasses.map((pass) => [pass.name, pass]));
    const shuffled = [
      byName.get("fragments"),
      byName.get("share"),
      byName.get("dynamic_matrix"),
      byName.get("fallback"),
      byName.get("retry"),
      byName.get("when_compile"),
      byName.get("for_each"),
      byName.get("params"),
      byName.get("job_defaults"),
    ].filter((pass): pass is Pass => pass !== undefined);
    const ordered = sortPasses(shuffled).map((pass) => pass.name);
    expect(ordered.indexOf("params")).toBeLessThan(ordered.indexOf("job_defaults"));
    expect(ordered.indexOf("job_defaults")).toBeLessThan(ordered.indexOf("for_each"));
    expect(ordered.indexOf("params")).toBeLessThan(ordered.indexOf("when_compile"));
    expect(ordered.indexOf("for_each")).toBeLessThan(ordered.indexOf("when_compile"));
    expect(ordered.indexOf("when_compile")).toBeLessThan(ordered.indexOf("fragments"));
    expect(ordered.indexOf("fragments")).toBeLessThan(ordered.indexOf("share"));
    expect(ordered.indexOf("share")).toBeLessThan(ordered.indexOf("retry"));
    expect(ordered.indexOf("retry")).toBeLessThan(ordered.indexOf("fallback"));
    expect(ordered.indexOf("fallback")).toBeLessThan(ordered.indexOf("dynamic_matrix"));
  });

  it("ignores forward dependency references to not-yet-registered passes", () => {
    const log: string[] = [];
    const passes = [
      recorder("when_compile", ["params", "for_each"], log),
      recorder("params", [], log),
    ];
    expect(() => sortPasses(passes)).not.toThrow();
    expect(sortPasses(passes).map((pass) => pass.name)).toEqual(["params", "when_compile"]);
  });

  it("resolves the built-in pipeline to the documented order", () => {
    expect(sortPasses(builtinPasses).map((p) => p.name)).toEqual([
      "params",
      "job_defaults",
      "for_each",
      "when_compile",
      "fragments",
      "share",
      "retry",
      "fallback",
      "dynamic_matrix",
      "lifecycle",
      "if_changed",
      "injection-hoist",
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
      "job_defaults",
      "for_each",
      "when_compile",
      "fragments",
      "share",
      "retry",
      "fallback",
      "dynamic_matrix",
      "lifecycle",
      "if_changed",
      "injection-hoist",
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

describe("createRegistry", () => {
  it("seeds the built-in pipeline in dependency order", () => {
    expect(
      createRegistry()
        .list()
        .map((p) => p.name),
    ).toEqual([
      "params",
      "job_defaults",
      "for_each",
      "when_compile",
      "fragments",
      "share",
      "retry",
      "fallback",
      "dynamic_matrix",
      "lifecycle",
      "if_changed",
      "injection-hoist",
    ]);
  });

  it("lets a caller-supplied pass override a same-named built-in", () => {
    const log: string[] = [];
    const override = recorder("for_each", ["params"], log);
    const baseline = createRegistry().list().length;
    const registry = createRegistry([override]);
    expect(registry.list().filter((p) => p.name === "for_each")).toEqual([override]);
    expect(registry.list().length).toBe(baseline);
  });
});

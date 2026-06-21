import type { ParseContext } from "actio-core";
import {
  applyPasses,
  builtinPasses,
  createRegistry,
  type Pass,
  PassRegistry,
  parseActio,
  runPasses,
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

const sourceWithParamsInterpolation = `name: x
on: [push]
params:
  env:
    type: string
    default: prod
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
env:
  TARGET: "{{ params.env }}"
`;

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
    expect(fragmentsPass?.runsAfter ?? []).toContain("when-compile");
  });

  it("enforces when-compile before fragments from metadata even with shuffled input", () => {
    const byName = new Map(builtinPasses.map((pass) => [pass.name, pass]));
    const shuffled = [
      byName.get("fragments"),
      byName.get("share"),
      byName.get("dynamic-matrix"),
      byName.get("fallback"),
      byName.get("retry"),
      byName.get("soft-fail"),
      byName.get("when-compile"),
      byName.get("for-each"),
      byName.get("params"),
      byName.get("job-defaults"),
    ].filter((pass): pass is Pass => pass !== undefined);
    const ordered = sortPasses(shuffled).map((pass) => pass.name);
    expect(ordered.indexOf("params")).toBeLessThan(ordered.indexOf("job-defaults"));
    expect(ordered.indexOf("job-defaults")).toBeLessThan(ordered.indexOf("for-each"));
    expect(ordered.indexOf("params")).toBeLessThan(ordered.indexOf("when-compile"));
    expect(ordered.indexOf("for-each")).toBeLessThan(ordered.indexOf("when-compile"));
    expect(ordered.indexOf("when-compile")).toBeLessThan(ordered.indexOf("fragments"));
    expect(ordered.indexOf("fragments")).toBeLessThan(ordered.indexOf("share"));
    expect(ordered.indexOf("share")).toBeLessThan(ordered.indexOf("retry"));
    expect(ordered.indexOf("retry")).toBeLessThan(ordered.indexOf("fallback"));
    expect(ordered.indexOf("fallback")).toBeLessThan(ordered.indexOf("dynamic-matrix"));
    expect(ordered.indexOf("retry")).toBeLessThan(ordered.indexOf("soft-fail"));
    expect(ordered.indexOf("fallback")).toBeLessThan(ordered.indexOf("soft-fail"));
  });

  it("ignores forward dependency references to not-yet-registered passes", () => {
    const log: string[] = [];
    const passes = [
      recorder("when-compile", ["params", "for-each"], log),
      recorder("params", [], log),
    ];
    expect(() => sortPasses(passes)).not.toThrow();
    expect(sortPasses(passes).map((pass) => pass.name)).toEqual(["params", "when-compile"]);
  });

  it("resolves the built-in pipeline to the documented order", () => {
    expect(sortPasses(builtinPasses).map((p) => p.name)).toEqual([
      "params",
      "reusable",
      "call-templates",
      "job-defaults",
      "for-each",
      "when-compile",
      "fragments",
      "share",
      "retry",
      "fallback",
      "soft-fail",
      "dynamic-matrix",
      "expand-matrix",
      "lifecycle",
      "if-changed",
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

  it("leaves final compile-time text interpolation to the complete public pipeline", () => {
    const ctx = parseActio(sourceWithParamsInterpolation, "t.actio.yml");
    applyPasses(ctx, builtinPasses);

    expect((ctx.data.env as { TARGET?: string }).TARGET).toBe("{{ params.env }}");
  });
});

describe("runPasses", () => {
  it("runs passes and resolves final compile-time text interpolation", () => {
    const ctx = parseActio(sourceWithParamsInterpolation, "t.actio.yml");
    runPasses(ctx);

    expect((ctx.data.env as { TARGET?: string }).TARGET).toBe("prod");
    expect(ctx.data.params).toBeUndefined();
  });
});

describe("PassRegistry", () => {
  it("lets you add a pass and runs it in dependency order", () => {
    const log: string[] = [];
    const registry = new PassRegistry(builtinPasses);
    registry.register(recorder("post", ["dynamic-matrix"], log));
    expect(registry.list().map((p) => p.name)).toEqual([
      "params",
      "reusable",
      "call-templates",
      "job-defaults",
      "for-each",
      "when-compile",
      "fragments",
      "share",
      "retry",
      "fallback",
      "soft-fail",
      "dynamic-matrix",
      "expand-matrix",
      "lifecycle",
      "if-changed",
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

  it("runs the complete public pass pipeline", () => {
    const ctx = parseActio(sourceWithParamsInterpolation, "t.actio.yml");
    new PassRegistry(builtinPasses).run(ctx);

    expect((ctx.data.env as { TARGET?: string }).TARGET).toBe("prod");
    expect(ctx.data.params).toBeUndefined();
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
      "reusable",
      "call-templates",
      "job-defaults",
      "for-each",
      "when-compile",
      "fragments",
      "share",
      "retry",
      "fallback",
      "soft-fail",
      "dynamic-matrix",
      "expand-matrix",
      "lifecycle",
      "if-changed",
      "injection-hoist",
    ]);
  });

  it("lets a caller-supplied pass override a same-named built-in", () => {
    const log: string[] = [];
    const override = recorder("for-each", ["params"], log);
    const baseline = createRegistry().list().length;
    const registry = createRegistry([override]);
    expect(registry.list().filter((p) => p.name === "for-each")).toEqual([override]);
    expect(registry.list().length).toBe(baseline);
  });
});

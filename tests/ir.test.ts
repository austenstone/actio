import {
  applyPasses,
  builtinPasses,
  originOf,
  parseActio,
  visitJobs,
  visitSteps,
  workflow,
} from "@actio/core";
import { describe, expect, it } from "vitest";

function ctxOf(source: string) {
  return parseActio(source, "t.actio.yml");
}

describe("visitor", () => {
  const src = `name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo hi
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`;

  it("workflow() is a typed view over ctx.data", () => {
    const ctx = ctxOf(src);
    expect(workflow(ctx)).toBe(ctx.data);
  });

  it("visitJobs walks every job with a stable path", () => {
    const ctx = ctxOf(src);
    const ids: string[] = [];
    visitJobs(ctx, ({ id, path }) => {
      ids.push(id);
      expect(path).toEqual(["jobs", id]);
    });
    expect(ids).toEqual(["a", "b"]);
  });

  it("visitSteps walks every step and records a resolvable origin", () => {
    const ctx = ctxOf(src);
    const seen: Array<[string, number]> = [];
    visitSteps(ctx, ({ jobId, index, step, path, origin }) => {
      seen.push([jobId, index]);
      expect(path).toEqual(["jobs", jobId, "steps", index]);
      expect(origin.range).toBeDefined();
      expect(originOf(ctx, step)).toBe(origin);
    });
    expect(seen).toEqual([
      ["a", 0],
      ["a", 1],
      ["b", 0],
    ]);
  });
});

describe("provenance survives passes", () => {
  it("retry attempt and sleep steps map back to the original step", () => {
    const ctx = ctxOf(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: flaky
        retry:
          max: 2
          delay: 5
`);
    applyPasses(ctx, builtinPasses);
    const steps = ctx.data.jobs.a.steps as Array<Record<string, unknown>>;
    expect(steps.length).toBeGreaterThan(1);
    for (const step of steps) {
      const origin = originOf(ctx, step);
      expect(origin).toBeDefined();
      expect(origin?.path).toEqual(["jobs", "a", "steps", 0]);
    }
  });

  it("dynamic_matrix setup job maps back to its target job", () => {
    const ctx = ctxOf(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    dynamic_matrix:
      script: echo '{"include":[]}'
    steps:
      - run: echo build
`);
    applyPasses(ctx, builtinPasses);
    const setup = Object.entries(ctx.data.jobs).find(([id]) => id.startsWith("actio_"));
    expect(setup).toBeDefined();
    const origin = originOf(ctx, setup?.[1] as object);
    expect(origin).toBeDefined();
    expect(origin?.path).toEqual(["jobs", "build"]);
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildOptions } from "./build.js";
import { type RebuildSummary, type WatchController, runWatch } from "./watch.js";

const SOURCE_A = `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
`;

const SOURCE_B = `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`;

const baseOpts = (cwd: string): BuildOptions => ({
  outDir: "out",
  check: false,
  stdout: false,
  validate: true,
  header: false,
  sourceMap: false,
  cwd,
});

// A tiny async signal so tests can await the next rebuild deterministically
// instead of polling the filesystem.
const makeSignal = () => {
  const queue: RebuildSummary[] = [];
  const waiters: ((s: RebuildSummary) => void)[] = [];
  return {
    onRebuild: (summary: RebuildSummary) => {
      const waiter = waiters.shift();
      if (waiter) waiter(summary);
      else queue.push(summary);
    },
    next: (): Promise<RebuildSummary> =>
      new Promise((resolve) => {
        const queued = queue.shift();
        if (queued) resolve(queued);
        else waiters.push(resolve);
      }),
  };
};

describe("runWatch", () => {
  let dir: string;
  let controller: WatchController | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "actio-watch-"));
  });

  afterEach(async () => {
    await controller?.close();
    controller = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("builds initially and rebuilds the changed file on save", async () => {
    await writeFile(path.join(dir, "a.actio.yml"), SOURCE_A, "utf8");
    const signal = makeSignal();
    const ready = new Promise<void>((resolve) => {
      controller = undefined;
      void runWatch([], baseOpts(dir), { onRebuild: signal.onRebuild, onReady: resolve }).then(
        (c) => {
          controller = c;
        },
      );
    });

    const initial = await signal.next();
    expect(initial.initial).toBe(true);
    expect(initial.results.map((r) => r.file)).toEqual(["a.actio.yml"]);

    const outPath = path.join(dir, "out", "a.yml");
    expect(await readFile(outPath, "utf8")).toContain("echo a");

    await ready;
    await writeFile(path.join(dir, "a.actio.yml"), SOURCE_B, "utf8");

    const rebuild = await signal.next();
    expect(rebuild.initial).toBe(false);
    expect(rebuild.results.map((r) => r.file)).toEqual(["a.actio.yml"]);
    expect(await readFile(outPath, "utf8")).toContain("echo b");
  }, 15000);

  it("rebuilds when a brand-new .actio.yml file appears", async () => {
    await writeFile(path.join(dir, "b.actio.yml"), SOURCE_B, "utf8");
    const signal = makeSignal();
    const ready = new Promise<void>((resolve) => {
      void runWatch([], baseOpts(dir), { onRebuild: signal.onRebuild, onReady: resolve }).then(
        (c) => {
          controller = c;
        },
      );
    });

    await signal.next(); // initial
    await ready;

    await writeFile(path.join(dir, "c.actio.yml"), SOURCE_A, "utf8");

    const rebuild = await signal.next();
    expect(rebuild.results.map((r) => r.file)).toEqual(["c.actio.yml"]);
    expect(await readFile(path.join(dir, "out", "c.yml"), "utf8")).toContain("echo a");
  }, 15000);

  it("keeps watching after a transpile error", async () => {
    await writeFile(path.join(dir, "bad.actio.yml"), "this: : not valid yaml\n", "utf8");
    const signal = makeSignal();
    const ready = new Promise<void>((resolve) => {
      void runWatch([], baseOpts(dir), { onRebuild: signal.onRebuild, onReady: resolve }).then(
        (c) => {
          controller = c;
        },
      );
    });

    const initial = await signal.next();
    expect(initial.results.some((r) => r.errored)).toBe(true);

    await ready;
    await writeFile(path.join(dir, "bad.actio.yml"), SOURCE_A, "utf8");

    const rebuild = await signal.next();
    expect(rebuild.results.some((r) => r.errored)).toBe(false);
    expect(await readFile(path.join(dir, "out", "bad.yml"), "utf8")).toContain("echo a");
  }, 15000);
});

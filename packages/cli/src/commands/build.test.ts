import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BuildOptions, runBuild } from "./build.js";

const INPUT = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
  "",
].join("\n");

function options(cwd: string, overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    outDir: "out",
    check: false,
    stdout: false,
    validate: true,
    header: true,
    sourceMap: true,
    annotate: false,
    cwd,
    ...overrides,
  };
}

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "actio-cli-"));
  await writeFile(join(dir, "ci.actio.yml"), INPUT, "utf8");
  return dir;
}

afterEach(() => vi.restoreAllMocks());

describe("runBuild source maps", () => {
  it("writes a .yml.map sidecar next to the workflow", async () => {
    const dir = await workdir();
    const code = await runBuild([], options(dir));
    expect(code).toBe(0);

    const yamlPath = join(dir, "out", "ci.yml");
    const mapPath = join(dir, "out", "ci.yml.map");
    expect(existsSync(yamlPath)).toBe(true);
    expect(existsSync(mapPath)).toBe(true);

    const map = JSON.parse(await readFile(mapPath, "utf8"));
    expect(map.version).toBe(1);
    expect(map.file).toBe("ci.yml");
    expect(map.sources).toEqual(["ci.actio.yml"]);
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  it("omits the sidecar with sourceMap disabled", async () => {
    const dir = await workdir();
    await runBuild([], options(dir, { sourceMap: false }));
    expect(existsSync(join(dir, "out", "ci.yml"))).toBe(true);
    expect(existsSync(join(dir, "out", "ci.yml.map"))).toBe(false);
  });

  it("writes nothing to disk in --stdout mode", async () => {
    const dir = await workdir();
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = await runBuild([], options(dir, { stdout: true }));
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalled();
    expect(existsSync(join(dir, "out", "ci.yml"))).toBe(false);
    expect(existsSync(join(dir, "out", "ci.yml.map"))).toBe(false);
  });

  it("treats a stale source map as drift under --check", async () => {
    const dir = await workdir();
    await runBuild([], options(dir));
    // Up to date: no drift.
    expect(await runBuild([], options(dir, { check: true }))).toBe(0);

    // Corrupt the sidecar so it no longer matches the regenerated map.
    await mkdir(join(dir, "out"), { recursive: true });
    await writeFile(join(dir, "out", "ci.yml.map"), "{}\n", "utf8");
    expect(await runBuild([], options(dir, { check: true }))).toBe(1);
  });
});

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ActioConfig } from "@actio/core";
import { createJiti } from "jiti";
import type { BuildOptions } from "./commands/build.js";

const CONFIG_BASENAME = "actio.config";
const EXTENSIONS = ["ts", "mts", "cts", "js", "mjs", "cjs", "json"] as const;
const DEFAULT_OUT_DIR = ".github/workflows";

export interface LoadedConfig {
  config: ActioConfig;
  filepath: string;
}

/** Find the nearest `actio.config.*` walking up from `cwd` to the filesystem root. */
function findConfigFile(cwd: string): string | null {
  let dir = path.resolve(cwd);
  while (true) {
    for (const ext of EXTENSIONS) {
      const candidate = path.join(dir, `${CONFIG_BASENAME}.${ext}`);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Discover and load an `actio.config.*` file from `cwd` upward. Returns `null`
 * when none is found. JSON is parsed directly; everything else (TS/ESM/CJS) is
 * evaluated through jiti so config authors can use TypeScript with no build step.
 */
export async function loadActioConfig(cwd: string = process.cwd()): Promise<LoadedConfig | null> {
  const filepath = findConfigFile(cwd);
  if (!filepath) return null;

  let config: ActioConfig;
  if (filepath.endsWith(".json")) {
    config = JSON.parse(readFileSync(filepath, "utf8")) as ActioConfig;
  } else {
    const jiti = createJiti(import.meta.url);
    config = await jiti.import<ActioConfig>(filepath, { default: true });
  }

  if (typeof config !== "object" || config === null) {
    throw new Error(`${path.relative(cwd, filepath)} must export a config object`);
  }
  return { config, filepath };
}

/**
 * Resolve build options with precedence: explicit CLI flag > config file > default.
 * Pure (argv and config are injected) so precedence is unit-testable. cac can't
 * distinguish a defaulted negated boolean from an explicit one, hence the argv scan.
 */
export function resolveBuildOptions(args: {
  files: string[];
  flags: { outDir?: string };
  forceCheck: boolean;
  argv: string[];
  config: ActioConfig;
}): { patterns: string[]; options: BuildOptions } {
  const { files, flags, forceCheck, argv, config } = args;
  const passed = (name: string) =>
    argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`));

  const options: BuildOptions = {
    outDir: passed("--out-dir") && flags.outDir ? flags.outDir : (config.outDir ?? DEFAULT_OUT_DIR),
    check: forceCheck || passed("--check"),
    stdout: passed("--stdout"),
    validate: passed("--no-validate") ? false : (config.validate ?? true),
    header: passed("--no-header") ? false : (config.header ?? true),
    passes: config.passes,
  };

  const patterns = files.length > 0 ? files : (config.files ?? config.include ?? []);
  return { patterns, options };
}

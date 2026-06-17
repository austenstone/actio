import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { cac } from "cac";
import pc from "picocolors";
import { type BuildOptions, runBuild } from "./commands/build.js";
import { runSchema } from "./commands/schema.js";
import { runWatch } from "./commands/watch.js";
import { type LoadedConfig, loadActioConfig, resolveBuildOptions } from "./config.js";
import { STARTER_ACTIO } from "./starter.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

interface CliBuildFlags {
  config?: string;
  outDir?: string;
  check?: boolean;
  stdout?: boolean;
  validate: boolean;
  header: boolean;
  watch?: boolean;
}

const cli = cac("actio");

/** Load the config file, then merge it with CLI flags (explicit flag > config > default). */
async function resolveOptions(
  files: string[],
  flags: CliBuildFlags,
  forceCheck: boolean,
): Promise<{ patterns: string[]; options: BuildOptions }> {
  let loaded: LoadedConfig | null = null;
  try {
    loaded = await loadActioConfig(process.cwd(), flags.config);
  } catch (err) {
    process.stderr.write(`${pc.red("error")}: ${(err as Error).message}\n`);
    process.exit(1);
  }
  return resolveBuildOptions({
    files,
    flags,
    forceCheck,
    argv: process.argv.slice(2),
    config: loaded?.config ?? {},
  });
}

async function startWatch(files: string[], flags: CliBuildFlags) {
  const { patterns, options } = await resolveOptions(files, flags, false);
  const controller = await runWatch(patterns, options);
  const shutdown = async () => {
    await controller.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

cli
  .command("build [...files]", "Compile .actio.yml files into GitHub Actions workflows")
  .option("--config <file>", "Path to an actio config file (overrides auto-discovery)")
  .option("--out-dir <dir>", "Output directory for generated workflows")
  .option("--check", "Verify generated output is up to date without writing (CI drift check)")
  .option("--stdout", "Write generated YAML to stdout instead of files")
  .option("-w, --watch", "Rebuild on change and keep running (like tsc --watch)")
  .option("--no-validate", "Skip schema validation of generated workflows")
  .option("--no-header", "Omit the generated-by-Actio banner")
  .option("--no-source-map", "Do not write a .yml.map source map beside each workflow")
  .option("--no-annotate", "Do not inject the actio-annotate runtime failure-mapping job")
  .action(async (files: string[], flags: CliBuildFlags) => {
    if (flags.watch) {
      await startWatch(files, flags);
      return;
    }
    const { patterns, options } = await resolveOptions(files, flags, false);
    process.exitCode = await runBuild(patterns, options);
  });

cli
  .command("watch [...files]", "Watch .actio.yml files and rebuild workflows on change")
  .option("--config <file>", "Path to an actio config file (overrides auto-discovery)")
  .option("--out-dir <dir>", "Output directory for generated workflows", {
    default: ".github/workflows",
  })
  .option("--no-validate", "Skip schema validation of generated workflows")
  .option("--no-header", "Omit the generated-by-Actio banner")
  .action(async (files: string[], flags: CliBuildFlags) => {
    await startWatch(files, flags);
  });

cli
  .command(
    "check [...files]",
    "Verify generated workflows are up to date (alias for build --check)",
  )
  .option("--config <file>", "Path to an actio config file (overrides auto-discovery)")
  .option("--out-dir <dir>", "Output directory for generated workflows")
  .option("--no-validate", "Skip schema validation of generated workflows")
  .option("--no-header", "Omit the generated-by-Actio banner")
  .option("--no-source-map", "Ignore the .yml.map source map in the drift check")
  .option("--no-annotate", "Do not inject the actio-annotate runtime failure-mapping job")
  .action(async (files: string[], flags: CliBuildFlags) => {
    const { patterns, options } = await resolveOptions(files, flags, true);
    process.exitCode = await runBuild(patterns, options);
  });

cli
  .command("init [file]", "Scaffold a starter .actio.yml file")
  .action(async (file = "ci.actio.yml") => {
    if (existsSync(file)) {
      process.stderr.write(`${pc.yellow("warning")}: ${file} already exists; not overwriting\n`);
      process.exitCode = 1;
      return;
    }
    await writeFile(file, STARTER_ACTIO, "utf8");
    process.stderr.write(`${pc.green("✓")} created ${file}\n`);
  });

cli
  .command("schema", "Print the Actio JSON Schema (or write it locally with --out)")
  .option("--out <file>", "Write the schema to a local file instead of stdout")
  .action(async (flags: { out?: string }) => {
    process.exitCode = await runSchema(flags.out);
  });

cli.help();
cli.version(pkg.version);

cli.parse();

import { readFileSync } from "node:fs";
import { cac } from "cac";
import pc from "picocolors";
import { type BuildOptions, runBuild } from "./commands/build.js";
import { runInit } from "./commands/init.js";
import {
  type PinsExitCode,
  runPinsApplyConstrained,
  runPinsCheck,
  runPinsUpdate,
} from "./commands/pins.js";
import { runSchema } from "./commands/schema.js";
import { runWatch } from "./commands/watch.js";
import { type LoadedConfig, loadActioConfig, resolveBuildOptions } from "./config.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

interface CliBuildFlags {
  config?: string;
  outDir?: string;
  target?: string;
  check?: boolean;
  stdout?: boolean;
  validate: boolean;
  header: boolean;
  watch?: boolean;
}

interface CliPinsCheckFlags {
  outDir?: string;
}

interface CliPinsUpdateFlags extends CliPinsCheckFlags {
  noExec: boolean;
  deltaOut?: string;
}

interface CliPinsApplyFlags {
  constrained?: string;
}

const cli = cac("actio");

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runPinsCommand = async (run: () => Promise<PinsExitCode>): Promise<void> => {
  try {
    process.exitCode = await run();
  } catch (error) {
    process.stderr.write(`${pc.red("error")}: ${formatError(error)}\n`);
    process.exitCode = 2;
  }
};

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
  try {
    return resolveBuildOptions({
      files,
      flags,
      forceCheck,
      argv: process.argv.slice(2),
      config: loaded?.config ?? {},
    });
  } catch (err) {
    process.stderr.write(`${pc.red("error")}: ${(err as Error).message}\n`);
    process.exit(1);
  }
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
  .option(
    "--target <profile>",
    "Output target profile (legacy | github-actions-native-dependencies-preview)",
  )
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
  .option(
    "--target <profile>",
    "Output target profile (legacy | github-actions-native-dependencies-preview)",
  )
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
  .option(
    "--target <profile>",
    "Output target profile (legacy | github-actions-native-dependencies-preview)",
  )
  .option("--no-validate", "Skip schema validation of generated workflows")
  .option("--no-header", "Omit the generated-by-Actio banner")
  .option("--no-source-map", "Ignore the .yml.map source map in the drift check")
  .option("--no-annotate", "Do not inject the actio-annotate runtime failure-mapping job")
  .action(async (files: string[], flags: CliBuildFlags) => {
    const { patterns, options } = await resolveOptions(files, flags, true);
    process.exitCode = await runBuild(patterns, options);
  });

cli
  .command("init [name]", "Scaffold a starter .actio.yml file (defaults to ci.actio.yml)")
  .action(async (name?: string) => {
    process.exitCode = await runInit(name);
  });

cli
  .command("schema", "Print the Actio JSON Schema (or write it locally with --out)")
  .option("--out <file>", "Write the schema to a local file instead of stdout")
  .action(async (flags: { out?: string }) => {
    process.exitCode = await runSchema(flags.out);
  });

cli
  .command("pins check [...files]", "Check pin drift (exit 1) and integrity mismatches (exit 2)")
  .option("--out-dir <dir>", "Generated workflow directory (default .github/workflows)")
  .action(async (files: string[], flags: CliPinsCheckFlags) => {
    await runPinsCommand(() => runPinsCheck(files, { outDir: flags.outDir }));
  });

cli
  .command(
    "pins update [...files]",
    "Resolve/update pin state; with --no-exec, performs only mechanical rewrite",
  )
  .option("--out-dir <dir>", "Generated workflow directory (default .github/workflows)")
  .option("--delta-out <file>", "Where to write the constrained delta artifact")
  .option("--no-exec", "Do not run build/config/custom passes; rewrite only")
  .action(async (files: string[], flags: CliPinsUpdateFlags) => {
    await runPinsCommand(() =>
      runPinsUpdate(files, {
        outDir: flags.outDir,
        noExec: flags.noExec,
        deltaOut: flags.deltaOut,
        runBuild: async (patterns, cwd) => {
          const loaded = await loadActioConfig(cwd);
          const { patterns: buildPatterns, options } = resolveBuildOptions({
            files: patterns,
            flags: { outDir: flags.outDir },
            forceCheck: false,
            argv: process.argv.slice(2),
            config: loaded?.config ?? {},
          });
          options.cwd = cwd;
          await runBuild(buildPatterns, options);
        },
      }),
    );
  });

cli
  .command("pins apply", "Apply a precomputed pin delta with constrained allowlist checks")
  .option("--constrained <delta>", "Constrained delta file produced by pins update --no-exec")
  .action(async (flags: CliPinsApplyFlags) => {
    const deltaFile = flags.constrained;
    if (!deltaFile) {
      process.stderr.write(`${pc.red("error")}: pins apply requires --constrained <delta>\n`);
      process.exitCode = 2;
      return;
    }
    await runPinsCommand(() => runPinsApplyConstrained(deltaFile));
  });

cli.help();
cli.version(pkg.version);

const parsed = cli.parse(process.argv, { run: false });
if (!parsed.options.help && !parsed.options.version) {
  if (!cli.matchedCommand) {
    if (parsed.args.length === 0) {
      // Bare `actio`: show help rather than silently exiting 0.
      cli.outputHelp();
      process.exit(0);
    }
    process.stderr.write(`${pc.red("error")}: unknown command "${parsed.args[0]}"\n`);
    cli.outputHelp();
    process.exit(1);
  }
  await cli.runMatchedCommand();
}

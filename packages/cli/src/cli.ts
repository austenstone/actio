import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { cac } from "cac";
import pc from "picocolors";
import { runBuild } from "./commands/build.js";
import { runSchema } from "./commands/schema.js";
import { runWatch } from "./commands/watch.js";
import { STARTER_ACTIO } from "./starter.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

interface CliBuildFlags {
  outDir: string;
  check?: boolean;
  stdout?: boolean;
  validate: boolean;
  header: boolean;
  watch?: boolean;
}

const cli = cac("actio");

function buildOptions(flags: CliBuildFlags, check: boolean) {
  return {
    outDir: flags.outDir,
    check: check || Boolean(flags.check),
    stdout: Boolean(flags.stdout),
    validate: flags.validate,
    header: flags.header,
  };
}

async function startWatch(files: string[], flags: CliBuildFlags) {
  const controller = await runWatch(files, buildOptions(flags, false));
  const shutdown = async () => {
    await controller.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

cli
  .command("build [...files]", "Compile .actio.yml files into GitHub Actions workflows")
  .option("--out-dir <dir>", "Output directory for generated workflows", {
    default: ".github/workflows",
  })
  .option("--check", "Verify generated output is up to date without writing (CI drift check)")
  .option("--stdout", "Write generated YAML to stdout instead of files")
  .option("-w, --watch", "Rebuild on change and keep running (like tsc --watch)")
  .option("--no-validate", "Skip schema validation of generated workflows")
  .option("--no-header", "Omit the generated-by-Actio banner")
  .action(async (files: string[], flags: CliBuildFlags) => {
    if (flags.watch) {
      await startWatch(files, flags);
      return;
    }
    const code = await runBuild(files, buildOptions(flags, false));
    process.exitCode = code;
  });

cli
  .command("watch [...files]", "Watch .actio.yml files and rebuild workflows on change")
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
  .option("--out-dir <dir>", "Output directory for generated workflows", {
    default: ".github/workflows",
  })
  .option("--no-validate", "Skip schema validation of generated workflows")
  .option("--no-header", "Omit the generated-by-Actio banner")
  .action(async (files: string[], flags: CliBuildFlags) => {
    const code = await runBuild(files, buildOptions({ ...flags, check: true }, true));
    process.exitCode = code;
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

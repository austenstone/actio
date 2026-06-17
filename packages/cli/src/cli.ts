import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { cac } from "cac";
import pc from "picocolors";
import { runBuild } from "./commands/build.js";
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

cli
  .command("build [...files]", "Compile .actio.yml files into GitHub Actions workflows")
  .option("--out-dir <dir>", "Output directory for generated workflows", {
    default: ".github/workflows",
  })
  .option("--check", "Verify generated output is up to date without writing (CI drift check)")
  .option("--stdout", "Write generated YAML to stdout instead of files")
  .option("--no-validate", "Skip schema validation of generated workflows")
  .option("--no-header", "Omit the generated-by-Actio banner")
  .action(async (files: string[], flags: CliBuildFlags) => {
    const code = await runBuild(files, buildOptions(flags, false));
    process.exitCode = code;
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

cli.help();
cli.version(pkg.version);

cli.parse();

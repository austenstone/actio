import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

const invokeCli = async (args: string[]) => {
  const originalExitCode = process.exitCode;
  const stdout: string[] = [];
  const stderr: string[] = [];

  process.exitCode = undefined;

  try {
    await runCli(["node", "actio", ...args], {
      stdout: (message) => {
        stdout.push(`${message}\n`);
      },
      stderr: (message) => {
        stderr.push(message);
      },
    });
    return { exitCode: process.exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.exitCode = originalExitCode;
  }
};

describe("cli entrypoint", () => {
  it("prints help and exits 0 for bare invocation", async () => {
    const result = await invokeCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("build [...files]");
    expect(result.stderr).toBe("");
  });

  it("prints help for --help", async () => {
    const result = await invokeCli(["--help"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("build [...files]");
    expect(result.stderr).toBe("");
  });

  it("prints version for --version", async () => {
    const result = await invokeCli(["--version"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toMatch(/^actio\/0\.1\.0 /);
    expect(result.stderr).toBe("");
  });

  it("prints an error, shows help, and exits 1 for unknown commands", async () => {
    const result = await invokeCli(["nope"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown command "nope"');
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("Commands:");
  });
});

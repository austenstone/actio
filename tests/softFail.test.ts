import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transpile } from "actio-core";
import { describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

vi.setConfig({ testTimeout: 15000, hookTimeout: 15000 });

/**
 * The authoritative proof for soft_fail is execution, not string matching: we
 * compile a workflow, pull the emitted `run` back out, and run it through the
 * exact outer shell invocation GitHub uses so the OBSERVED process exit code is
 * what an actual runner would see.
 */

type StepObj = Record<string, unknown>;
type Defaults = { run?: { shell?: string } };

function buildSource(
  step: StepObj,
  opts: { jobDefaults?: Defaults; workflowDefaults?: Defaults; extraSteps?: unknown[] } = {},
): string {
  const job: Record<string, unknown> = {
    "runs-on": "ubuntu-latest",
    steps: [step, ...(opts.extraSteps ?? [])],
  };
  if (opts.jobDefaults) job.defaults = opts.jobDefaults;
  const wf: Record<string, unknown> = { on: ["push"], jobs: { j: job } };
  if (opts.workflowDefaults) wf.defaults = opts.workflowDefaults;
  return stringify(wf);
}

function compile(step: StepObj, opts?: Parameters<typeof buildSource>[1]) {
  const result = transpile(buildSource(step, opts), { fileName: "t.actio.yml", validate: false });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const doc = result.ok ? parse(result.yaml) : undefined;
  const emitted = doc?.jobs?.j?.steps?.[0] as StepObj | undefined;
  return { result, errors, doc, emitted };
}

type ShellKind = "bash" | "sh" | "pwsh";

const HAS_PWSH = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

/**
 * Replays the emitted `run` exactly the way the GitHub runner would: bash and sh
 * scripts get the documented strict invocation; pwsh is wrapped the way the
 * runner does (Stop + native throw armed, dot-sourced) so our wrapper has to
 * survive the same self-sabotage in the test as in production.
 */
function observe(run: string, shell: ShellKind): { code: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "sf-"));
  try {
    if (shell === "pwsh") {
      const file = join(dir, "step.ps1");
      const wrapped = `$ErrorActionPreference = 'stop'\n$PSNativeCommandUseErrorActionPreference = $true\n${run}\nif (Test-Path -LiteralPath variable:LASTEXITCODE) { exit $LASTEXITCODE }\n`;
      writeFileSync(file, wrapped);
      const r = spawnSync("pwsh", ["-NoProfile", "-Command", `. '${file}'`], { encoding: "utf8" });
      return { code: r.status ?? -1, stdout: r.stdout ?? "" };
    }
    const file = join(dir, "step.sh");
    writeFileSync(file, run);
    const argv =
      shell === "bash" ? ["--noprofile", "--norc", "-eo", "pipefail", file] : ["-e", file];
    const r = spawnSync(shell, argv, { encoding: "utf8" });
    return { code: r.status ?? -1, stdout: r.stdout ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const posixShells: ShellKind[] = ["bash", "sh"];

describe.each(posixShells)("execution oracle (%s)", (shell) => {
  function run(script: string, soft: number[] | boolean) {
    const { emitted, errors } = compile({ run: script, soft_fail: soft, shell });
    expect(errors).toEqual([]);
    return observe(emitted?.run as string, shell);
  }

  it("(a) script exits 0 -> wrapper exits 0", () => {
    expect(run("echo ok", [0, 42]).code).toBe(0);
  });

  it("(b) allowed non-zero (42) -> wrapper exits 0", () => {
    expect(run("echo go\n(exit 42)", [0, 42]).code).toBe(0);
  });

  it("(c) disallowed code (1) -> wrapper exits the real 1", () => {
    expect(run("echo go\nfalse", [0, 42]).code).toBe(1);
  });

  it("(d) multi-line failing partway with an allowed code -> wrapper exits 0", () => {
    const r = run("echo first\n(exit 42)\necho second", [0, 42]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("first");
    expect(r.stdout).not.toContain("second");
  });

  it("(e) explicit `exit 42` (allowed) -> wrapper exits 0", () => {
    expect(run("echo a\nexit 42\necho b", [0, 42]).code).toBe(0);
  });

  it("(f) explicit `exit 7` (disallowed) -> wrapper exits the real 7", () => {
    expect(run("echo a\nexit 7\necho b", [0, 42]).code).toBe(7);
  });

  it("preserves inner fail-fast: a disallowed mid-script failure suppresses the tail", () => {
    const r = run("echo HEAD\nfalse\necho TAIL", [42]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("HEAD");
    expect(r.stdout).not.toContain("TAIL");
  });

  it("embeds arbitrary bytes safely (quotes, $, backticks, printf specifiers)", () => {
    const nasty = "echo 'it'\\''s %d $HOME `id`'\nexit 42";
    const r = run(nasty, [42]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("it's %d $HOME `id`");
  });
});

describe.skipIf(!HAS_PWSH)("execution oracle (pwsh)", () => {
  function run(script: string, soft: number[]) {
    const { emitted, errors } = compile({ run: script, soft_fail: soft, shell: "pwsh" });
    expect(errors).toEqual([]);
    return observe(emitted?.run as string, "pwsh");
  }

  it("(a) exit 0 -> 0", () => {
    expect(run("Write-Output ok", [0, 42]).code).toBe(0);
  });

  it("(b) allowed exit 42 -> 0", () => {
    expect(run("Write-Output go\nexit 42", [0, 42]).code).toBe(0);
  });

  it("(c) disallowed exit 1 -> 1", () => {
    expect(run("Write-Output go\nexit 1", [0, 42]).code).toBe(1);
  });

  it("(f) disallowed exit 7 -> 7", () => {
    expect(run("exit 7", [0, 42]).code).toBe(7);
  });

  it("(d) multi-line failing partway with an allowed code -> 0 and stdout flows", () => {
    const r = run("Write-Output first\nexit 42\nWrite-Output second", [0, 42]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("first");
    expect(r.stdout).not.toContain("second");
  });
});

describe("emission: shells and wrapper shape", () => {
  it("pins bash when no shell is set and emits the temp-file wrapper", () => {
    const { emitted, errors } = compile({ run: "echo hi", soft_fail: [0, 42] });
    expect(errors).toEqual([]);
    expect(emitted?.shell).toBe("bash");
    expect(emitted?.run).toContain('bash --noprofile --norc -eo pipefail "$__actio_sf_file"');
    expect(emitted?.run).toContain('case "$__actio_sf_code" in 0|42)');
  });

  it("uses the sh invocation for a sh step and leaves the shell untouched", () => {
    const { emitted } = compile({ run: "echo hi", soft_fail: [42], shell: "sh" });
    expect(emitted?.shell).toBe("sh");
    expect(emitted?.run).toContain('sh -e "$__actio_sf_file"');
  });

  it("emits a pwsh wrapper keyed on $LASTEXITCODE for a pwsh step", () => {
    const { emitted } = compile({ run: "Write-Output hi", soft_fail: [0, 42], shell: "pwsh" });
    expect(emitted?.shell).toBe("pwsh");
    expect(emitted?.run).toContain("$LASTEXITCODE");
    expect(emitted?.run).toContain("@(0, 42) -contains");
    expect(emitted?.run).not.toContain("case ");
  });

  it("dedupes repeated codes in the case arm", () => {
    const { emitted } = compile({ run: "echo hi", soft_fail: [0, 42, 42, 0], shell: "bash" });
    expect(emitted?.run).toContain("in 0|42)");
    expect(emitted?.run).not.toContain("0|42|42");
  });

  it("resolves the shell from job defaults", () => {
    const { emitted } = compile(
      { run: "echo hi", soft_fail: [42] },
      { jobDefaults: { run: { shell: "sh" } } },
    );
    expect(emitted?.run).toContain('sh -e "$__actio_sf_file"');
    expect(emitted?.shell).toBeUndefined();
  });

  it("resolves the shell from workflow defaults", () => {
    const { emitted } = compile(
      { run: "echo hi", soft_fail: [42] },
      { workflowDefaults: { run: { shell: "bash" } } },
    );
    expect(emitted?.run).toContain("bash --noprofile --norc -eo pipefail");
    expect(emitted?.shell).toBeUndefined();
  });

  it("pins bash when defaults exist but specify no shell", () => {
    const { emitted } = compile(
      { run: "echo hi", soft_fail: [42] },
      { jobDefaults: { run: {} }, workflowDefaults: {} },
    );
    expect(emitted?.shell).toBe("bash");
  });
});

describe("true vs list semantics", () => {
  it("soft_fail: true on a run step maps to continue-on-error", () => {
    const { emitted, errors } = compile({ run: "echo hi", soft_fail: true });
    expect(errors).toEqual([]);
    expect(emitted?.["continue-on-error"]).toBe(true);
    expect(emitted?.run).toBe("echo hi");
  });

  it("soft_fail: true on a uses step maps to continue-on-error", () => {
    const { emitted, errors } = compile({ uses: "actions/checkout@v4", soft_fail: true });
    expect(errors).toEqual([]);
    expect(emitted?.["continue-on-error"]).toBe(true);
  });

  it("soft_fail: false is a no-op with no diagnostic", () => {
    const { emitted, errors, result } = compile({ run: "echo hi", soft_fail: false });
    expect(errors).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(emitted?.run).toBe("echo hi");
    expect(emitted?.["continue-on-error"]).toBeUndefined();
  });
});

describe("preservation of sibling step keys", () => {
  it("carries env, working-directory, if, name through onto the wrapped step", () => {
    const { emitted } = compile({
      name: "Check",
      if: "always()",
      "working-directory": "./sub",
      env: { FOO: "bar" },
      run: "echo hi",
      soft_fail: [42],
      shell: "bash",
    });
    expect(emitted?.name).toBe("Check");
    expect(emitted?.if).toBe("always()");
    expect(emitted?.["working-directory"]).toBe("./sub");
    expect(emitted?.env).toEqual({ FOO: "bar" });
    expect(emitted?.run).toContain("__actio_sf_file");
  });
});

describe("diagnostics", () => {
  function errOf(step: StepObj, opts?: Parameters<typeof buildSource>[1]) {
    const { result, errors } = compile(step, opts);
    expect(result.ok).toBe(false);
    return errors.map((e) => e.message).join("\n");
  }

  it("rejects an exit-code list on a uses step", () => {
    expect(errOf({ uses: "actions/checkout@v4", soft_fail: [0, 42] })).toMatch(/only applies to/);
  });

  it("rejects a list on an unsupported shell", () => {
    expect(errOf({ run: "echo hi", soft_fail: [42], shell: "cmd" })).toMatch(/supports only/);
  });

  it("rejects out-of-range codes", () => {
    expect(errOf({ run: "echo hi", soft_fail: [300] })).toMatch(/0-255/);
  });

  it("rejects negative codes", () => {
    expect(errOf({ run: "echo hi", soft_fail: [-1] })).toMatch(/0-255/);
  });

  it("rejects non-integer codes", () => {
    expect(errOf({ run: "echo hi", soft_fail: [1.5] })).toMatch(/0-255/);
  });

  it("rejects non-numeric entries", () => {
    expect(errOf({ run: "echo hi", soft_fail: ["nope"] })).toMatch(/0-255/);
  });

  it("rejects an empty list", () => {
    expect(errOf({ run: "echo hi", soft_fail: [] })).toMatch(/at least one/);
  });

  it("rejects a non-boolean non-array value", () => {
    expect(errOf({ run: "echo hi", soft_fail: "true" })).toMatch(/must be true or a list/);
  });
});

describe("interaction with retry", () => {
  it("wraps every flattened retry attempt with the soft_fail mapping", () => {
    const { doc, errors } = compile({ run: "echo hi", soft_fail: [42], shell: "bash", retry: 2 });
    expect(errors).toEqual([]);
    const steps = doc.jobs.j.steps as StepObj[];
    const wrapped = steps.filter(
      (s) => typeof s.run === "string" && s.run.includes("__actio_sf_file"),
    );
    expect(wrapped.length).toBe(2);
    for (const s of wrapped) {
      const r = observe(s.run as string, "bash");
      expect(r.code).toBe(0);
    }
  });
});

describe("non-object steps pass through untouched", () => {
  it("ignores a bare string step", () => {
    const { doc, errors } = compile(
      { run: "echo hi", soft_fail: [42], shell: "bash" },
      { extraSteps: ["a string step"] },
    );
    expect(errors).toEqual([]);
    expect(doc.jobs.j.steps[1]).toBe("a string step");
  });
});

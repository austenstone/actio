import { applyPasses, builtinPasses, parseActio, transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { buildShareWriter } from "../packages/core/src/passes/share.js";

function diagnosticsFor(source: string, validate = true) {
  return transpile(source, { fileName: "t.actio.yml", validate }).diagnostics;
}

function errorCodes(source: string, validate = true): string[] {
  return diagnosticsFor(source, validate)
    .filter((d) => d.severity === "error")
    .map((d) => d.code ?? "");
}

function warningCodes(source: string, validate = true): string[] {
  return diagnosticsFor(source, validate)
    .filter((d) => d.severity === "warning")
    .map((d) => d.code ?? "");
}

function symbolsFor(source: string) {
  const ctx = parseActio(source, "t.actio.yml");
  applyPasses(ctx, builtinPasses);
  return ctx.symbols;
}

const PRODUCER = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Resolve
        run: VERSION=1
        share:
          version: $VERSION
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.version }}`;

describe("buildShareWriter (per-iteration-name writer primitive)", () => {
  it("emits a single-line value writer for the name it is handed", () => {
    const writer = buildShareWriter("version", "build", "step_resolve", {
      kind: "value",
      expr: "$VERSION",
    });
    expect(writer).toBe('echo "version=$VERSION" >> "$GITHUB_OUTPUT"');
  });

  it("writes whatever per-iteration name it is handed (share<->for_each seam primitive)", () => {
    const writer = buildShareWriter("version_macos", "build", "step_resolve", {
      kind: "capture",
      lines: ["sw_vers -productVersion"],
    });
    // The for_each seam hands this primitive a per-key name like `version_macos`;
    // the writer must use that exact name with no re-derivation.
    expect(writer).toContain("echo 'version_macos<<ACTIO_EOF_version_macos_");
    expect(writer).toContain("  sw_vers -productVersion");
    expect(writer.endsWith('} >> "$GITHUB_OUTPUT"')).toBe(true);
  });

  it("adds a runtime guard only when required is set", () => {
    const guarded = buildShareWriter(
      "v",
      "j",
      "s",
      { kind: "value", expr: "$X" },
      { required: true },
    );
    expect(guarded).toContain('[ -n "$X" ] || { echo "::error::empty share value"; exit 1; }');
    const plain = buildShareWriter("v", "j", "s", { kind: "value", expr: "$X" });
    expect(plain).not.toContain("::error::empty share value");
  });

  it("captures single-line stdout into a temp var when required is set", () => {
    const writer = buildShareWriter(
      "rev",
      "build",
      "step_resolve",
      { kind: "capture", lines: ["git rev-parse HEAD"] },
      { required: true },
    );
    expect(writer).toContain("__actio_share_rev=$(git rev-parse HEAD)");
    expect(writer).toContain("printf '%s\\n' \"$__actio_share_rev\"");
    expect(writer).toContain('[ -n "$__actio_share_rev" ] ||');
  });

  it("captures multi-line stdout (subshell) and guards it when required", () => {
    const writer = buildShareWriter(
      "notes",
      "build",
      "step_resolve",
      { kind: "capture", lines: ["echo a", "echo b"] },
      { required: true },
    );
    expect(writer).toContain("__actio_share_notes=$(");
    expect(writer).toContain("  echo a");
    expect(writer).toContain("  echo b");
    expect(writer).toContain('[ -n "$__actio_share_notes" ] ||');
  });

  it("sanitizes hyphens in the name when building the capture temp var", () => {
    const writer = buildShareWriter(
      "build-id",
      "j",
      "s",
      { kind: "capture", lines: ["uuidgen"] },
      { required: true },
    );
    expect(writer).toContain("__actio_share_build_id=$(uuidgen)");
  });
});

describe("per-output heredoc delimiter", () => {
  it("is deterministic for the same (name, job, step)", () => {
    const a = buildShareWriter("notes", "j", "s", { kind: "capture", lines: ["git log"] });
    const b = buildShareWriter("notes", "j", "s", { kind: "capture", lines: ["git log"] });
    expect(a).toBe(b);
  });

  it("differs per output name so a captured line can never collide by construction", () => {
    const notes = buildShareWriter("notes", "j", "s", { kind: "capture", lines: ["x"] });
    const cfg = buildShareWriter("cfg", "j", "s", { kind: "capture", lines: ["x"] });
    const notesDelim = notes.match(/ACTIO_EOF_notes_[0-9a-f]{8}/)?.[0];
    const cfgDelim = cfg.match(/ACTIO_EOF_cfg_[0-9a-f]{8}/)?.[0];
    expect(notesDelim).toBeDefined();
    expect(cfgDelim).toBeDefined();
    expect(notesDelim).not.toBe(cfgDelim);
  });
});

describe("boolean asymmetry (LOCKED)", () => {
  it("registers a typed shared-output symbol that is not compile-time-known", () => {
    const symbols = symbolsFor(PRODUCER);
    const sym = symbols.get("version");
    expect(sym).toBeDefined();
    expect(sym?.kind).toBe("shared-output");
    expect(sym?.compileTimeKnown).toBe(false);
  });

  it("treats type: boolean as a TYPE assertion only — injects NO runtime coercion", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          ready:
            value: "true"
            type: boolean
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.ready }}`;
    const yaml = transpile(source, { fileName: "t.actio.yml" }).yaml;
    // Diverges from #17's boolean *param* (which injects fromJSON(...)==true):
    // a boolean shared-output emits the bare job-output ref, no coercion wrapper.
    expect(yaml).toContain("${{ needs.build.outputs.ready }}");
    expect(yaml).not.toContain("fromJSON(needs.build.outputs.ready) == true");
    const sym = symbolsFor(source).get("ready");
    expect(sym?.type).toBe("boolean");
  });
});

describe("share diagnostics (§5)", () => {
  it("5.1 invalid name", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          "1bad": $X`;
    expect(errorCodes(source)).toContain("share/invalid-name");
  });

  it("5.2 unknown shared value lists available names", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          version: $X
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.missing }}`;
    const unknown = diagnosticsFor(source).find((d) => d.code === "share/unknown");
    expect(unknown).toBeDefined();
    expect(unknown?.message).toContain("version");
  });

  it("5.3 ambiguous when two jobs produce the same name", () => {
    const source = `name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          version: $A
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          version: $B
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.version }}`;
    expect(errorCodes(source)).toContain("share/ambiguous");
  });

  it("qualified ${{ share.<job>.<name> }} disambiguates the collision", () => {
    const source = `name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          version: $A
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          version: $B
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.a.version }}`;
    const yaml = transpile(source, { fileName: "t.actio.yml" }).yaml;
    expect(errorCodes(source)).not.toContain("share/ambiguous");
    expect(yaml).toContain("${{ needs.a.outputs.version }}");
  });

  it("5.4 dotted reference on a non-json share", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          cfg: $X
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.cfg.env }}`;
    expect(errorCodes(source)).toContain("share/not-json");
  });

  it("5.5 needs cycle introduced by sharing", () => {
    const source = `name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.b }}
        share:
          a: $A
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.a }}
        share:
          b: $B`;
    expect(errorCodes(source, false)).toContain("share/cycle");
  });

  it("5.6 duplicate name within one job", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo one
        share:
          version: $A
      - run: echo two
        share:
          version: $B`;
    expect(errorCodes(source)).toContain("share/duplicate");
  });

  it("5.7 warns when share is placed on a job, not a step", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    share:
      version: $X
    steps:
      - run: echo ok`;
    expect(warningCodes(source)).toContain("share/on-job");
  });

  it("5.8 warns when a matrix job produces a shared value", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - run: echo ok
        share:
          version: $X
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.version }}`;
    expect(warningCodes(source)).toContain("share/matrix");
  });

  it("5.9 warns when a shared value is derived from a secret", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          token: \${{ secrets.TOKEN }}
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.token }}`;
    expect(warningCodes(source)).toContain("share/secret");
  });
});

describe("share wiring", () => {
  it("same-job reference lowers to steps.* with no needs/outputs", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Tag
        run: TAG=1
        share:
          tag: $TAG
      - run: echo \${{ share.tag }}`;
    const yaml = transpile(source, { fileName: "t.actio.yml" }).yaml;
    expect(yaml).toContain("${{ steps.step_tag.outputs.tag }}");
    expect(yaml).not.toContain("needs:");
    expect(yaml).not.toContain("outputs:");
  });

  it("$${{ share.x }} escapes to a literal token (not rewritten)", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          version: $X
  docs:
    runs-on: ubuntu-latest
    steps:
      - run: echo "see $\${{ share.version }}"`;
    const yaml = transpile(source, { fileName: "t.actio.yml", validate: false }).yaml;
    expect(yaml).toContain("${{ share.version }}");
    expect(yaml).not.toContain("needs.build.outputs.version");
  });
});

describe("share source shapes", () => {
  it("accepts a bare number scalar and types it as number", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          retries: 3
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.retries }}`;
    const yaml = transpile(source, { fileName: "t.actio.yml" }).yaml;
    expect(yaml).toContain('echo "retries=3" >> "$GITHUB_OUTPUT"');
    expect(symbolsFor(source).get("retries")?.type).toBe("number");
  });

  it("accepts a bare boolean scalar and types it as boolean (no coercion)", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          ready: true
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ share.ready }}`;
    const yaml = transpile(source, { fileName: "t.actio.yml" }).yaml;
    expect(yaml).toContain('echo "ready=true" >> "$GITHUB_OUTPUT"');
    expect(yaml).not.toContain("fromJSON(");
    expect(symbolsFor(source).get("ready")?.type).toBe("boolean");
  });

  it("errors when a mapping share has neither value: nor run:", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share:
          cfg:
            json: true`;
    expect(errorCodes(source)).toContain("share/missing-source");
  });

  it("errors when share: is not a mapping of outputs", () => {
    const source = `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        share: nope`;
    expect(errorCodes(source)).toContain("share/invalid");
  });
});

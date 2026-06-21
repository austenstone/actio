import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PinPolicy, PinTarget } from "actio-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BuildOptions,
  buildOne,
  DockerRegistryUnresolvableError,
  outputPathFor,
  resolveDockerDigest,
  runBuild,
} from "../packages/cli/src/commands/build.js";
import { readLock } from "../packages/cli/src/commands/lock.js";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;

const SOURCE = `name: ci
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: docker://alpine:3.18
`;

const GHCR_SOURCE = `name: ci
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: docker://ghcr.io/acme/tool:1.2.3
`;

const defaultPolicy = (over: Partial<PinPolicy> = {}): PinPolicy => ({
  enabled: true,
  thirdParty: true,
  github: false,
  docker: true,
  allow: [],
  comment: "tag",
  ...over,
});

let dir: string;

const opts = (over: Partial<BuildOptions> = {}): BuildOptions => ({
  outDir: "out",
  check: false,
  stdout: false,
  validate: false,
  header: false,
  sourceMap: false,
  annotate: false,
  target: "legacy",
  cwd: dir,
  pin: defaultPolicy(),
  lockPath: path.join(dir, "actio.lock"),
  ...over,
});

const mockResolver = () => ({
  resolve: vi.fn(async (t: PinTarget) => (t.kind === "docker" ? DIGEST : SHA)),
});

const write = (src = SOURCE) => {
  const file = "ci.actio.yml";
  writeFileSync(path.join(dir, file), src, "utf8");
  return file;
};

const readOutput = (file: string, o: BuildOptions) =>
  readFileSync(outputPathFor(file, path.resolve(dir, o.outDir)), "utf8");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "actio-pin-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("pin build orchestration", () => {
  it("pins third-party refs and leaves first-party on their tag by default", async () => {
    const file = write();
    const o = opts({ pinResolver: mockResolver() });
    await buildOne(file, dir, o);
    const out = readOutput(file, o);

    expect(out).toContain(`pnpm/action-setup@${SHA} # v2`);
    expect(out).toContain("actions/checkout@v4");
    expect(out).not.toContain(`actions/checkout@${SHA}`);
  });

  it("rewrites docker tags to their digest with the tag preserved", async () => {
    const file = write();
    const o = opts({ pinResolver: mockResolver() });
    await buildOne(file, dir, o);

    expect(readOutput(file, o)).toContain(`docker://alpine@${DIGEST} # 3.18`);
  });

  it("writes resolved digests to the lock cache", async () => {
    const file = write();
    const o = opts({ pinResolver: mockResolver() });
    await buildOne(file, dir, o);

    const lock = await readLock(dir, o.lockPath);
    expect(lock.data.pins?.["pnpm/action-setup@v2"]).toMatchObject({
      ref: "v2",
      digest: SHA,
    });
    expect(lock.data.pins?.["docker://alpine:3.18"]).toMatchObject({
      ref: "3.18",
      digest: DIGEST,
    });
  });

  it("also pins first-party refs when policy.github is on", async () => {
    const file = write();
    const o = opts({ pin: defaultPolicy({ github: true }), pinResolver: mockResolver() });
    await buildOne(file, dir, o);

    expect(readOutput(file, o)).toContain(`actions/checkout@${SHA} # v4`);
  });

  it("resolves from the lock cache offline without hitting the resolver", async () => {
    const file = write();
    const seed = mockResolver();
    await buildOne(file, dir, opts({ pinResolver: seed }));
    expect(seed.resolve).toHaveBeenCalled();

    const offlineResolver = mockResolver();
    const o = opts({ offline: true, pinResolver: offlineResolver });
    await buildOne(file, dir, o);

    expect(offlineResolver.resolve).not.toHaveBeenCalled();
    expect(readOutput(file, o)).toContain(`pnpm/action-setup@${SHA} # v2`);
  });

  it("re-pinning is idempotent: the second build hits only the cache", async () => {
    const file = write();
    const resolver = mockResolver();
    await buildOne(file, dir, opts({ pinResolver: resolver }));
    const firstCalls = resolver.resolve.mock.calls.length;

    const o = opts({ pinResolver: resolver });
    await buildOne(file, dir, o);

    expect(resolver.resolve.mock.calls.length).toBe(firstCalls);
    expect(readOutput(file, o)).toContain(`pnpm/action-setup@${SHA} # v2`);
  });

  it("exits 2 when offline and the lock is missing an entry", async () => {
    write();
    const code = await runBuild(["ci.actio.yml"], opts({ offline: true }));
    expect(code).toBe(2);
  });

  it("pinned output round-trips through the check drift gate", async () => {
    const file = write();
    await buildOne(file, dir, opts({ pinResolver: mockResolver() }));

    const result = await buildOne(file, dir, opts({ check: true, offline: true }));
    expect(result.drift).toBe(false);
  });

  const seedLock = (pins: Record<string, { ref: string; digest: string }>) => {
    const data = {
      version: 1,
      actions: {},
      imports: {},
      pins: Object.fromEntries(
        Object.entries(pins).map(([k, v]) => [k, { ...v, resolvedAt: "2025-01-01T00:00:00Z" }]),
      ),
    };
    writeFileSync(path.join(dir, "actio.lock"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };

  it("rejects a corrupt action digest in the lock instead of emitting a wrong pin", async () => {
    const file = write();
    seedLock({
      "pnpm/action-setup@v2": { ref: "v2", digest: "abc123" },
      "docker://alpine:3.18": { ref: "3.18", digest: DIGEST },
    });

    await expect(buildOne(file, dir, opts({ offline: true }))).rejects.toThrow(/corrupt pin/);
  });

  it("rejects a docker key holding an action-shaped SHA in the lock", async () => {
    const file = write();
    seedLock({
      "pnpm/action-setup@v2": { ref: "v2", digest: SHA },
      "docker://alpine:3.18": { ref: "3.18", digest: SHA },
    });

    await expect(buildOne(file, dir, opts({ offline: true }))).rejects.toThrow(/corrupt pin/);
  });

  it("skips an unresolvable docker registry with a warning instead of failing", async () => {
    const file = write(GHCR_SOURCE);
    const resolver = {
      resolve: vi.fn(async (t: PinTarget) => {
        throw new DockerRegistryUnresolvableError(t.key, `unsupported docker registry "ghcr.io"`);
      }),
    };
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const result = await buildOne(file, dir, opts({ pinResolver: resolver }));
    const out = readOutput(file, opts());

    expect(result.errored).toBe(false);
    expect(out).toContain("docker://ghcr.io/acme/tool:1.2.3");
    expect(out).not.toContain("@sha256:");
    const warnings = stderr.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("pin-unresolvable-registry"));
    expect(warnings).toHaveLength(1);
  });

  it("still hard-fails when a responding registry returns a corrupt digest", async () => {
    const file = write(GHCR_SOURCE);
    const resolver = {
      resolve: vi.fn(async () => {
        throw new Error("Docker Hub returned a malformed digest");
      }),
    };

    await expect(buildOne(file, dir, opts({ pinResolver: resolver }))).rejects.toThrow(
      /malformed digest/,
    );
  });
});

type FakeResponse = {
  ok: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  digest?: string | null;
};

const fakeResponse = (init: FakeResponse) => ({
  ok: init.ok,
  status: init.status ?? (init.ok ? 200 : 500),
  statusText: init.statusText ?? "",
  json: async () => init.json ?? {},
  headers: {
    get: (name: string) =>
      name.toLowerCase() === "docker-content-digest" ? (init.digest ?? null) : null,
  },
});

const stubDockerFetch = (token: FakeResponse, manifest: FakeResponse) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) =>
      String(url).includes("auth.docker.io") ? fakeResponse(token) : fakeResponse(manifest),
    ),
  );

// Skip-with-warning is narrowed to a structurally unsupported registry; any failure on
// Docker Hub itself must surface as a plain Error so it propagates and hard-fails rather
// than silently shipping the image unpinned (a transient 429 is the headline case).
describe("resolveDockerDigest registry failures", () => {
  const tokenOk: FakeResponse = { ok: true, json: { token: "t" } };

  const expectHardFail = async (id: string, ref: string, pattern: RegExp) => {
    const caught = await resolveDockerDigest(id, ref).catch((e) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DockerRegistryUnresolvableError);
    expect(String((caught as Error).message)).toMatch(pattern);
  };

  it("flags an unsupported registry host as the typed skip signal (no network)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const caught = await resolveDockerDigest("ghcr.io/acme/tool", "1.2.3").catch((e) => e);

    expect(caught).toBeInstanceOf(DockerRegistryUnresolvableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hard-fails (not the skip signal) on a Docker Hub manifest 429", async () => {
    stubDockerFetch(tokenOk, { ok: false, status: 429, statusText: "Too Many Requests" });
    await expectHardFail("alpine", "3.18", /429/);
  });

  it("hard-fails on Docker Hub manifest 500 and 503", async () => {
    stubDockerFetch(tokenOk, { ok: false, status: 503, statusText: "Service Unavailable" });
    await expectHardFail("alpine", "3.18", /503/);

    stubDockerFetch(tokenOk, { ok: false, status: 500, statusText: "Internal Server Error" });
    await expectHardFail("alpine", "3.18", /500/);
  });

  it("hard-fails on Docker Hub auth 401/403", async () => {
    stubDockerFetch({ ok: false, status: 401, statusText: "Unauthorized" }, tokenOk);
    await expectHardFail("alpine", "3.18", /401/);

    stubDockerFetch({ ok: false, status: 403, statusText: "Forbidden" }, tokenOk);
    await expectHardFail("alpine", "3.18", /403/);
  });

  it("hard-fails on a genuinely missing tag (Docker Hub 404)", async () => {
    stubDockerFetch(tokenOk, { ok: false, status: 404, statusText: "Not Found" });
    await expectHardFail("alpine", "nope", /404/);
  });

  it("hard-fails when a responding Docker Hub returns a malformed digest", async () => {
    stubDockerFetch(tokenOk, { ok: true, digest: "sha256:nothex" });
    await expectHardFail("alpine", "3.18", /malformed digest/);
  });

  it("returns the digest when Docker Hub resolves cleanly", async () => {
    stubDockerFetch(tokenOk, { ok: true, digest: DIGEST });
    expect(await resolveDockerDigest("alpine", "3.18")).toBe(DIGEST);
  });
});

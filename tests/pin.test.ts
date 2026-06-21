import {
  type PinPolicy,
  parseUsesRef,
  pinCommentText,
  shouldPinTarget,
  transpile,
} from "actio-core";
import { describe, expect, it } from "vitest";

const policy = (over: Partial<PinPolicy> = {}): PinPolicy => ({
  enabled: true,
  thirdParty: true,
  github: false,
  docker: true,
  allow: [],
  comment: "tag",
  ...over,
});

const pin = (source: string, over: Partial<PinPolicy> = {}, resolutions = {}) =>
  transpile(source, {
    header: false,
    validate: false,
    pin: { policy: policy(over), resolutions },
  });

const wf = (steps: string) => `
name: ci
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${steps}`;

describe("parseUsesRef", () => {
  it("classifies a third-party action", () => {
    expect(parseUsesRef("owner/action@v1")).toEqual({
      key: "owner/action@v1",
      kind: "action",
      id: "owner/action",
      ref: "v1",
      owner: "owner",
    });
  });

  it("classifies a subdir action ref", () => {
    expect(parseUsesRef("owner/repo/sub@v1")?.owner).toBe("owner");
  });

  it("classifies a docker ref", () => {
    expect(parseUsesRef("docker://node:20")).toEqual({
      key: "docker://node:20",
      kind: "docker",
      id: "node",
      ref: "20",
    });
  });

  it("classifies a docker ref with registry host + port", () => {
    expect(parseUsesRef("docker://registry.io:5000/img:1.2")).toMatchObject({
      id: "registry.io:5000/img",
      ref: "1.2",
    });
  });

  it("skips an already-pinned 40-hex action sha", () => {
    expect(parseUsesRef(`owner/action@${"a".repeat(40)}`)).toBeNull();
  });

  it("skips an already-digested docker ref", () => {
    expect(parseUsesRef("docker://node@sha256:abc")).toBeNull();
  });

  it("skips local, bare, and single-segment refs", () => {
    expect(parseUsesRef("./local")).toBeNull();
    expect(parseUsesRef("../up")).toBeNull();
    expect(parseUsesRef("owner/action")).toBeNull();
    expect(parseUsesRef("bare@v1")).toBeNull();
    expect(parseUsesRef("docker://node")).toBeNull();
  });
});

describe("shouldPinTarget", () => {
  const t = (uses: string) => {
    const target = parseUsesRef(uses);
    if (!target) throw new Error(`unpinnable: ${uses}`);
    return target;
  };

  it("pins third-party but skips first-party by default", () => {
    expect(shouldPinTarget(t("owner/action@v1"), policy())).toBe(true);
    expect(shouldPinTarget(t("actions/checkout@v4"), policy())).toBe(false);
    expect(shouldPinTarget(t("github/codeql-action@v3"), policy())).toBe(false);
  });

  it("pins first-party when github is enabled", () => {
    expect(shouldPinTarget(t("actions/checkout@v4"), policy({ github: true }))).toBe(true);
  });

  it("honors the docker toggle", () => {
    expect(shouldPinTarget(t("docker://node:20"), policy({ docker: false }))).toBe(false);
  });

  it("never pins when disabled", () => {
    expect(shouldPinTarget(t("owner/action@v1"), policy({ enabled: false }))).toBe(false);
  });

  it("leaves allow-globbed refs on their tag", () => {
    expect(shouldPinTarget(t("owner/action@v1"), policy({ allow: ["owner/*"] }))).toBe(false);
    expect(shouldPinTarget(t("docker://node:20"), policy({ allow: ["docker://node:20"] }))).toBe(
      false,
    );
  });
});

describe("pinCommentText", () => {
  it("renders tag, tag+date, and none", () => {
    expect(pinCommentText("v4", "tag")).toBe(" v4");
    expect(pinCommentText("v4", "tag+date", "2025-01-15T10:00:00Z")).toBe(" v4 (2025-01-15)");
    expect(pinCommentText("v4", "tag+date")).toBe(" v4");
    expect(pinCommentText("v4", "none")).toBe("");
  });
});

describe("applyPins via transpile", () => {
  const sha = "b".repeat(40);

  it("rewrites a third-party ref to its sha with a tag comment", () => {
    const out = pin(
      wf("      - uses: owner/action@v1"),
      {},
      { "owner/action@v1": { digest: sha } },
    );
    expect(out.yaml).toContain(`uses: owner/action@${sha} # v1`);
    expect(out.pinTargets?.map((t) => t.key)).toEqual(["owner/action@v1"]);
  });

  it("leaves first-party refs untouched by default", () => {
    const out = pin(wf("      - uses: actions/checkout@v4"));
    expect(out.yaml).toContain("uses: actions/checkout@v4");
    expect(out.pinTargets).toEqual([]);
  });

  it("rewrites docker refs to their digest", () => {
    const digest = "sha256:deadbeef";
    const out = pin(wf("      - uses: docker://node:20"), {}, { "docker://node:20": { digest } });
    expect(out.yaml).toContain(`uses: docker://node@${digest} # 20`);
  });

  it("emits tag+date comments from the resolution timestamp", () => {
    const out = pin(
      wf("      - uses: owner/action@v1"),
      { comment: "tag+date" },
      { "owner/action@v1": { digest: sha, resolvedAt: "2025-01-15T10:00:00Z" } },
    );
    expect(out.yaml).toContain(`uses: owner/action@${sha} # v1 (2025-01-15)`);
  });

  it("emits no comment when style is none", () => {
    const out = pin(
      wf("      - uses: owner/action@v1"),
      { comment: "none" },
      { "owner/action@v1": { digest: sha } },
    );
    expect(out.yaml).toContain(`uses: owner/action@${sha}`);
    expect(out.yaml).not.toContain("# v1");
  });

  it("surfaces unresolved targets without rewriting them", () => {
    const out = pin(wf("      - uses: owner/action@v1"));
    expect(out.yaml).toContain("uses: owner/action@v1");
    expect(out.pinTargets?.map((t) => t.key)).toEqual(["owner/action@v1"]);
  });

  it("is a no-op on already-pinned source refs", () => {
    const out = pin(wf(`      - uses: owner/action@${sha}`));
    expect(out.pinTargets).toEqual([]);
    expect(out.yaml).toContain(`uses: owner/action@${sha}`);
  });

  it("pins reusable-workflow job-level uses", () => {
    const source = `
name: ci
on: push
jobs:
  call:
    uses: owner/repo/.github/workflows/ci.yml@v1`;
    const out = pin(source, {}, { "owner/repo/.github/workflows/ci.yml@v1": { digest: sha } });
    expect(out.yaml).toContain(`uses: owner/repo/.github/workflows/ci.yml@${sha} # v1`);
  });

  it("dedupes repeated refs into a single target", () => {
    const out = pin(wf("      - uses: owner/action@v1\n      - uses: owner/action@v1"));
    expect(out.pinTargets).toHaveLength(1);
  });
});

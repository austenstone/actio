import { describe, expect, it } from "vitest";
import { normalizeInitTarget } from "./init.js";

describe("normalizeInitTarget", () => {
  it("defaults to ci.actio.yml", () => {
    expect(normalizeInitTarget()).toBe("ci.actio.yml");
    expect(normalizeInitTarget(undefined)).toBe("ci.actio.yml");
    expect(normalizeInitTarget("")).toBe("ci.actio.yml");
  });

  it("appends the .actio.yml suffix to a bare name", () => {
    expect(normalizeInitTarget("release")).toBe("release.actio.yml");
  });

  it("normalizes single .yml/.yaml extensions", () => {
    expect(normalizeInitTarget("ci.yml")).toBe("ci.actio.yml");
    expect(normalizeInitTarget("ci.yaml")).toBe("ci.actio.yml");
  });

  it("normalizes the full .actio.yml/.actio.yaml suffix", () => {
    expect(normalizeInitTarget("ci.actio.yml")).toBe("ci.actio.yml");
    expect(normalizeInitTarget("ci.actio.yaml")).toBe("ci.actio.yml");
  });

  it("is case-insensitive about extensions", () => {
    expect(normalizeInitTarget("ci.YML")).toBe("ci.actio.yml");
    expect(normalizeInitTarget("ci.Actio.Yaml")).toBe("ci.actio.yml");
  });

  it("preserves directory paths", () => {
    expect(normalizeInitTarget(".github/actio/ci")).toBe(".github/actio/ci.actio.yml");
    expect(normalizeInitTarget(".github/actio/ci.yml")).toBe(".github/actio/ci.actio.yml");
  });

  it("keeps dotted stems that are not extensions intact", () => {
    expect(normalizeInitTarget("ci.staging")).toBe("ci.staging.actio.yml");
  });
});

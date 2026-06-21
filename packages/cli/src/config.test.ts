import { describe, expect, it } from "vitest";
import { resolveBuildOptions } from "./config.js";

const resolve = (argv: string[], config: { strict?: boolean } = {}) =>
  resolveBuildOptions({ files: [], flags: {}, forceCheck: false, argv, config }).options.strict;

describe("resolveBuildOptions strict precedence", () => {
  it("defaults strict to false with no flag or config", () => {
    expect(resolve([])).toBe(false);
  });

  it("enables strict from the config file", () => {
    expect(resolve([], { strict: true })).toBe(true);
  });

  it("lets the --strict flag override a falsy config", () => {
    expect(resolve(["--strict"], { strict: false })).toBe(true);
  });
});

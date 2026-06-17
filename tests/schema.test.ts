import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { actioSchema, transpile } from "@actio/core";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { STARTER_ACTIO } from "../packages/cli/src/starter.js";

const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(actioSchema());

function load(source: string) {
  return parse(source) as unknown;
}

const ciSource = readFileSync(
  fileURLToPath(new URL("../.github/actio/ci.actio.yml", import.meta.url)),
  "utf8",
);

describe("actio json schema", () => {
  it("validates the dogfooded CI workflow source", () => {
    expect(validate(load(ciSource))).toBe(true);
  });

  it("validates the init starter (modeline ignored by yaml parse)", () => {
    expect(validate(load(STARTER_ACTIO))).toBe(true);
  });

  it("rejects retry below 2", () => {
    const doc = load(`on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: flaky
        retry: 1`);
    expect(validate(doc)).toBe(false);
  });

  it("rejects dynamic_matrix without script", () => {
    const doc = load(`on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    dynamic_matrix:
      alias: service
    steps:
      - run: echo hi`);
    expect(validate(doc)).toBe(false);
  });

  it("accepts retry object with delay and fallback recover", () => {
    const doc = load(`on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: flaky
        retry: { attempts: 3, delay: 10s }
        fallback:
          steps:
            - run: echo recovered
          recover: true`);
    expect(validate(doc)).toBe(true);
  });

  it("starter still transpiles cleanly with the modeline present", () => {
    const result = transpile(STARTER_ACTIO, { fileName: "ci.actio.yml" });
    expect(result.ok).toBe(true);
  });
});

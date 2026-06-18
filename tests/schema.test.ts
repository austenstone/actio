import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { actioSchema, transpile } from "actio-core";
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

  it("accepts top-level typed params", () => {
    const doc = load(`on: [push]
params:
  env:
    type: enum
    values: [dev, prod]
    default: dev
  retries:
    type: number
    default: 3
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "{{ params.env }}"`);
    expect(validate(doc)).toBe(true);
  });

  it("rejects enum params without values", () => {
    const doc = load(`on: [push]
params:
  env:
    type: enum
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi`);
    expect(validate(doc)).toBe(false);
  });

  it("rejects unknown keys on param definitions", () => {
    const doc = load(`on: [push]
params:
  env:
    type: string
    default: prod
    description: Production environment
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi`);
    expect(validate(doc)).toBe(false);
  });

  it("rejects non-enum params with values", () => {
    const doc = load(`on: [push]
params:
  env:
    type: string
    default: prod
    values: [dev, prod]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi`);
    expect(validate(doc)).toBe(false);
  });

  it("accepts executor arrays and executor definitions with timeout/permissions", () => {
    const doc = load(`on: [push]
executors:
  hardened:
    permissions:
      contents: read
    timeout-minutes: 10
  gpu:
    runs-on: [self-hosted, gpu]
jobs:
  release:
    executor: [hardened, gpu]
    runs-on: ubuntu-latest
    steps:
      - run: echo release`);
    expect(validate(doc)).toBe(true);
  });

  it("starter still transpiles cleanly with the modeline present", () => {
    const result = transpile(STARTER_ACTIO, { fileName: "ci.actio.yml" });
    expect(result.ok).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  actioSchema,
  CALL_TEMPLATE_KEYS,
  EXECUTOR_KEYS,
  JOB_DEFAULT_KEYS,
  transpile,
} from "actio-core";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { sampleSource } from "../docs/components/playground/sample";
import { STARTER_ACTIO } from "../packages/cli/src/starter.js";

const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(actioSchema());
const extensionsSchema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../packages/core/schema/actio.extensions.json", import.meta.url)),
    "utf8",
  ),
) as {
  addDefinitions: {
    jobDefaults: {
      properties: Record<string, unknown>;
    };
    executorDefinition: {
      properties: Record<string, unknown>;
    };
    callTemplateDefinition: {
      properties: Record<string, unknown>;
    };
  };
};

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

  it("rejects dynamic-matrix without script", () => {
    const doc = load(`on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    dynamic-matrix:
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

  it("accepts share value-form, capture-form, and json on a step", () => {
    const doc = load(`on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: VERSION=1.2.3
        share:
          version: $VERSION
          tag:
            value: $TAG
            required: true
            type: string
          config:
            run: cat config.json
            json: true`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts a share-only capture step that synthesizes run", () => {
    const doc = load(`on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Plan metadata
        share:
          deploy:
            run: jq -nc '{env:"preview"}'
            json: true`);
    expect(validate(doc)).toBe(true);
  });

  it("rejects an empty share mapping", () => {
    const doc = load(`on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        share: {}`);
    expect(validate(doc)).toBe(false);
  });

  it("rejects unknown keys in a share output definition", () => {
    const doc = load(`on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        share:
          version:
            value: $V
            bogus: true`);
    expect(validate(doc)).toBe(false);
  });

  it("rejects an unknown share output type", () => {
    const doc = load(`on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        share:
          version:
            value: $V
            type: weird`);
    expect(validate(doc)).toBe(false);
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

  it("accepts static-if directives on jobs and steps, including form B merge keys", () => {
    const doc = load(`on: [push]
params:
  deploy:
    type: boolean
    default: true
jobs:
  build:
    static-if: params.deploy
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: params.deploy
        static-if(params.deploy):
          timeout-minutes: 5
`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts step-scoped for-each loops", () => {
    const doc = load(`on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: service
          in: [api, web]
        steps:
          - run: npm run build --workspace {{ service }}`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts boolean static-if directives on jobs and steps", () => {
    const doc = load(`on: [push]
jobs:
  build:
    static-if: true
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: false
`);
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

  it("accepts executor arrays and executor definitions with runtime executor keys", () => {
    const doc = load(`on: [push]
executors:
  hardened:
    permissions:
      contents: read
    concurrency:
      group: hardened-group
    defaults:
      run:
        shell: bash
    env:
      HARDENED: "true"
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

  it("accepts normal jobs whose runs-on is supplied by an executor", () => {
    const doc = load(`on: [push]
executors:
  linux:
    runs-on: ubuntu-latest
jobs:
  test:
    executor: linux
    steps:
      - run: echo test`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts normal jobs whose runs-on is supplied by job-defaults", () => {
    const doc = load(`on: [push]
job-defaults:
  runs-on: ubuntu-latest
jobs:
  test:
    steps:
      - run: echo test`);
    expect(validate(doc)).toBe(true);
  });

  it("rejects plain normal jobs without runs-on or executor", () => {
    const doc = load(`on: [push]
jobs:
  test:
    steps:
      - run: echo test`);
    expect(validate(doc)).toBe(false);
  });

  it("rejects plain normal jobs when job-defaults does not supply runs-on", () => {
    const doc = load(`on: [push]
job-defaults:
  timeout-minutes: 10
jobs:
  test:
    steps:
      - run: echo test`);
    expect(validate(doc)).toBe(false);
  });

  it("rejects strategy in executor definitions", () => {
    const doc = load(`on: [push]
executors:
  bad:
    strategy:
      fail-fast: false
jobs:
  test:
    executor: bad
    runs-on: ubuntu-latest
    steps:
      - run: echo hi`);
    expect(validate(doc)).toBe(false);
  });

  it("accepts all allowlisted executor keys", () => {
    const doc = load(`on: [push]
executors:
  full:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    concurrency:
      group: full-group
    defaults:
      run:
        shell: bash
    container:
      image: node:20
    services:
      redis:
        image: redis:7
    env:
      CI: "true"
jobs:
  test:
    executor: full
    runs-on: ubuntu-latest
    steps:
      - run: echo hi`);
    expect(validate(doc)).toBe(true);
  });

  it("keeps executorDefinition in lockstep with runtime EXECUTOR_KEYS", () => {
    const runtimeKeys = [...EXECUTOR_KEYS].sort();
    const mergedKeys = Object.keys(
      (
        actioSchema() as {
          definitions: { executorDefinition: { properties: Record<string, unknown> } };
        }
      ).definitions.executorDefinition.properties,
    ).sort();
    const sourceKeys = Object.keys(
      extensionsSchema.addDefinitions.executorDefinition.properties,
    ).sort();

    expect(mergedKeys).toEqual(runtimeKeys);
    expect(sourceKeys).toEqual(runtimeKeys);
  });

  it("keeps jobDefaults schema in lockstep with runtime JOB_DEFAULT_KEYS", () => {
    const runtimeKeys = [...JOB_DEFAULT_KEYS].sort();
    const mergedKeys = Object.keys(
      (
        actioSchema() as {
          definitions: { jobDefaults: { properties: Record<string, unknown> } };
        }
      ).definitions.jobDefaults.properties,
    ).sort();
    const sourceKeys = Object.keys(extensionsSchema.addDefinitions.jobDefaults.properties).sort();

    expect(mergedKeys).toEqual(runtimeKeys);
    expect(sourceKeys).toEqual(runtimeKeys);
  });

  it("keeps callTemplateDefinition in lockstep with runtime CALL_TEMPLATE_KEYS", () => {
    const runtimeKeys = [...CALL_TEMPLATE_KEYS].sort();
    const mergedKeys = Object.keys(
      (
        actioSchema() as {
          definitions: { callTemplateDefinition: { properties: Record<string, unknown> } };
        }
      ).definitions.callTemplateDefinition.properties,
    ).sort();
    const sourceKeys = Object.keys(
      extensionsSchema.addDefinitions.callTemplateDefinition.properties,
    ).sort();

    expect(mergedKeys).toEqual(runtimeKeys);
    expect(sourceKeys).toEqual(runtimeKeys);
  });

  it("accepts a call job that extends a template without inline uses", () => {
    const doc = load(`on: [push]
call-templates:
  test:
    uses: ./.github/workflows/reuse.yml
jobs:
  unit:
    extends: test
    with:
      afterBuild: pnpm test`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts reusable-workflow call jobs without runs-on", () => {
    const doc = load(`on: [push]
jobs:
  call:
    uses: org/repo/.github/workflows/reuse.yml@main`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts extends as a list of template names", () => {
    const doc = load(`on: [push]
call-templates:
  base:
    uses: ./.github/workflows/reuse.yml
jobs:
  unit:
    extends: [base]`);
    expect(validate(doc)).toBe(true);
  });

  it("rejects extends combined with steps", () => {
    const doc = load(`on: [push]
call-templates:
  test:
    uses: ./.github/workflows/reuse.yml
jobs:
  unit:
    extends: test
    steps:
      - run: echo hi`);
    expect(validate(doc)).toBe(false);
  });

  it("rejects unknown keys in a call template definition", () => {
    const doc = load(`on: [push]
call-templates:
  test:
    uses: ./.github/workflows/reuse.yml
    runs-on: ubuntu-latest
jobs:
  unit:
    extends: test`);
    expect(validate(doc)).toBe(false);
  });

  it("accepts a step cross-file inject with with:", () => {
    const doc = load(`on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - inject: ./lib.actio.yml#setupNode
        with:
          node: 20`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts a job-body cross-file inject with sibling overrides", () => {
    const doc = load(`on: [push]
jobs:
  deploy:
    inject: ./lib.actio.yml#deployJob
    with:
      env: prod
    runs-on: ubuntu-24.04`);
    expect(validate(doc)).toBe(true);
  });

  it("rejects job-only keys in executor definitions", () => {
    for (const key of ["strategy", "if", "continue-on-error", "environment"]) {
      const doc = load(`on: [push]
executors:
  bad:
    ${key}: value
jobs:
  test:
    executor: bad
    runs-on: ubuntu-latest
    steps:
      - run: echo hi`);
      expect(validate(doc)).toBe(false);
    }
  });

  it("rejects strategy in job-defaults", () => {
    const doc = load(`on: [push]
job-defaults:
  strategy:
    fail-fast: false
    matrix:
      shard: [a, b]
jobs:
  call:
    uses: org/repo/.github/workflows/reuse.yml@main`);
    expect(validate(doc)).toBe(false);
  });

  it("accepts per-job strategy for reusable-workflow caller jobs", () => {
    const doc = load(`on: [push]
jobs:
  call:
    uses: org/repo/.github/workflows/reuse.yml@main
    strategy:
      fail-fast: false
      matrix:
        shard: [a, b]`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts continue-on-error and environment in job-defaults", () => {
    const doc = load(`on: [push]
job-defaults:
  continue-on-error: true
  environment: staging
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi`);
    expect(validate(doc)).toBe(true);
  });

  it("rejects non-allowlisted keys in job-defaults", () => {
    const doc = load(`on: [push]
job-defaults:
  steps:
    - run: echo nope
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi`);
    expect(validate(doc)).toBe(false);
  });

  it("starter still transpiles cleanly with the modeline present", () => {
    const result = transpile(STARTER_ACTIO, { fileName: "ci.actio.yml" });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("validates the playground sample source", () => {
    expect(validate(load(sampleSource))).toBe(true);
  });

  it("accepts injection-hoist macro keys on root, job, and step", () => {
    const doc = load(`on: [push]
injection-hoist: warn
jobs:
  a:
    runs-on: ubuntu-latest
    injection-hoist: error
    steps:
      - run: echo hi
        injection-hoist: "off"
        unsafe: true
        trust: [github.event.pull_request.title]
        force: [github.sha]`);
    expect(validate(doc)).toBe(true);
  });

  it("rejects an invalid injection-hoist mode", () => {
    const doc = load(`on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        injection-hoist: defuse`);
    expect(validate(doc)).toBe(false);
  });

  it("accepts a root coercion mode", () => {
    const doc = load(`on: [push]
coercion: warn
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi`);
    expect(validate(doc)).toBe(true);
  });

  it("rejects an invalid coercion mode", () => {
    const doc = load(`on: [push]
coercion: quote
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi`);
    expect(validate(doc)).toBe(false);
  });

  it("accepts a bare top-level finally block", () => {
    const doc = load(`on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
finally:
  teardown:
    runs-on: ubuntu-latest
    steps:
      - run: ./cleanup.sh`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts finally outcome branches and when: sugar", () => {
    const doc = load(`on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
finally:
  on-failure:
    rollback:
      runs-on: ubuntu-latest
      when: deploy.failed
      steps:
        - run: ./rollback.sh
  on-abort: []`);
    expect(validate(doc)).toBe(true);
  });

  it("rejects a non-mapping finally", () => {
    const doc = load(`on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./a.sh
finally: ./teardown.sh`);
    expect(validate(doc)).toBe(false);
  });

  it("accepts step-scoped ensure and on-failure hooks", () => {
    const doc = load(`on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        on-failure:
          - run: ./rollback.sh
        ensure:
          - run: ./cleanup.sh`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts job-scoped ensure and outcome hooks", () => {
    const doc = load(`on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    ensure:
      - run: ./teardown.sh
    on-success:
      - run: ./notify.sh
    steps:
      - run: ./build.sh`);
    expect(validate(doc)).toBe(true);
  });

  it("exposes finally and lifecycle grammar in the extensions surface", () => {
    const ext = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../packages/core/schema/actio.extensions.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      rootProperties: Record<string, unknown>;
      patchDefinitions: { step: { properties: Record<string, unknown> } };
      addDefinitions: Record<string, unknown>;
    };
    expect(ext.rootProperties).toHaveProperty("finally");
    expect(ext.patchDefinitions.step.properties).toHaveProperty("ensure");
    expect(ext.patchDefinitions.step.properties).toHaveProperty("on-failure");
    expect(ext.addDefinitions).toHaveProperty("finallyBlock");
    expect(ext.addDefinitions).toHaveProperty("lifecycleHook");
  });
});

describe("issue #107: macro-supplied job execution shape", () => {
  it("accepts the executor example from the issue verbatim", () => {
    const doc = load(`on: [push]
executors:
  node:
    runs-on: ubuntu-latest
jobs:
  plan:
    executor: node
    steps:
      - run: npm test`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts the extends example from the issue verbatim", () => {
    const doc = load(`on: [push]
call-templates:
  reusable-check:
    uses: ./.github/workflows/check.yml
jobs:
  reusable-unit:
    extends: reusable-check
    with:
      command: npm test`);
    expect(validate(doc)).toBe(true);
  });

  it("accepts a native reusable-workflow call job whose shape comes from uses", () => {
    const doc = load(`on: [push]
jobs:
  reusable-unit:
    uses: ./.github/workflows/check.yml`);
    expect(validate(doc)).toBe(true);
  });

  it("still rejects a plain job with none of runs-on, executor, uses, or extends", () => {
    const doc = load(`on: [push]
jobs:
  plan:
    steps:
      - run: npm test`);
    expect(validate(doc)).toBe(false);
  });
});

# Actio

> A transpiler that compiles a clean `.actio.yml` source into the verbose GitHub Actions YAML you'd otherwise hand-write.

Writing **dynamic** GitHub Actions workflows in raw YAML is painful. Actio adds a
small set of macro keywords — [`fragments`](#1-fragments--inject),
[`retry`](#2-retry), [`dynamic_matrix`](#3-dynamic_matrix), and
[`fallback`](#4-fallback) — that expand into the boilerplate GitHub requires.
Everything else is passthrough, so a macro-free `.actio.yml` file is just a normal
workflow.

Inspired by [Buildkite](https://buildkite.com/docs/pipelines/configure/dynamic-pipelines)'s
runtime `pipeline upload`. GitHub Actions can't inject steps at runtime — but we
**can** generate the correct YAML ahead of time from a higher-level source.

## Why

| Pain in raw YAML | Actio |
| --- | --- |
| Dynamic matrix needs a hand-built setup job that prints JSON to `$GITHUB_OUTPUT`, consumed downstream via `fromJSON()`, with escaping and empty-guard gotchas | `dynamic_matrix: { script, alias }` |
| Reusing 3 steps forces a separate [composite action](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action) or [reusable workflow](https://docs.github.com/en/actions/sharing-automations/reusing-workflows) file | in-file `fragments` + `inject` |
| Retrying flaky steps requires bash loops or third-party actions | `retry: { attempts, delay }` |
| try/catch means smearing `if: failure()` / `continue-on-error` across steps | `fallback:` block |

Prior art ([`github-actions-workflow-ts`](https://github.com/emmanuelnk/github-actions-workflow-ts),
[`github-actions-wac`](https://github.com/webiny/github-actions-wac),
[`projen`](https://github.com/projen/projen)) does typed object → YAML 1:1
serialization. Actio's differentiator is the **macro/transform compiler**.

## Install

```bash
npm install -D @actio/cli
# or run without installing:
npx @actio/cli build
```

Requires Node ≥ 20.

## Quickstart

```bash
# scaffold a starter source file
npx actio init ci.actio.yml

# compile *.actio.yml → .github/workflows/*.yml
npx actio build

# CI drift check (fails if generated output is stale)
npx actio check
```

**Recommended layout:** keep sources in `.github/actio/` and compile them into
`.github/workflows/` — the directory GitHub actually reads. Sources nested
outside `.github/workflows/` won't be mistaken for real workflows. Think of
`.github/workflows/` as your `dist`:

```
.github/
  actio/        # source: *.actio.yml (+ actio.config.ts)
  workflows/    # generated: *.yml (committed, GitHub runs these)
```


## Macros

### 1. `fragments` + `inject`

Define reusable step blocks at the top of the file; splice them in with
`- inject: <name>`.

**`.actio.yml`**
```yaml
name: Fragments
on: [push]
fragments:
  setup:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - inject: setup
      - run: npm test
```

**generated `.yml`** — `fragments` is stripped, `inject` expanded in place:
```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm test
```

### 2. `retry`

Retry flaky steps with automatic backoff. Works with both `run:` and `uses:` steps.

**`.actio.yml`**
```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to production
        uses: cloudflare/wrangler-action@v3
        retry:
          attempts: 3
          delay: 10s
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
```

**generated `.yml`** — fans out into conditional attempts, each gated on prior failure:
```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to production (attempt 1/3)
        uses: cloudflare/wrangler-action@v3
        id: step_deploy_to_production_attempt_1
        continue-on-error: true
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
      - name: Retry backoff (10s) before attempt 2/3
        run: sleep 10
        if: steps.step_deploy_to_production_attempt_1.outcome == 'failure'
      - name: Deploy to production (attempt 2/3)
        uses: cloudflare/wrangler-action@v3
        id: step_deploy_to_production_attempt_2
        if: steps.step_deploy_to_production_attempt_1.outcome == 'failure'
        continue-on-error: true
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
      - name: Retry backoff (10s) before attempt 3/3
        run: sleep 10
        if: steps.step_deploy_to_production_attempt_2.outcome == 'failure'
      - name: Deploy to production (attempt 3/3)
        uses: cloudflare/wrangler-action@v3
        id: step_deploy_to_production_attempt_3
        if: steps.step_deploy_to_production_attempt_2.outcome == 'failure'
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
```

How it works:
- Each attempt but the last gets `continue-on-error: true` so failure doesn't stop the job
- Attempt N runs only when attempt N-1 had `outcome == 'failure'`
- A success at any attempt short-circuits the rest; all-fail fails the job on the final attempt
- Each attempt gets a unique ID and auto-names as `"<step> (attempt N/max)"`

Options:
- `attempts` (required): number of times to retry (minimum 2)
- `delay` (optional): backoff between attempts, e.g., `"10s"`, `"2m"`, `"1h"` (injects `sleep` steps)

Shorthand: `retry: 3` is the same as `retry: { attempts: 3 }`

### 3. `dynamic_matrix`

The headline feature. A job-level block whose `script` prints a JSON array (or
`{include:[...]}`); Actio generates the setup job + wiring.

**`.actio.yml`**
```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    dynamic_matrix:
      script: ./scripts/list.sh
      alias: shard
    steps:
      - run: ./run-shard.sh ${{ matrix.shard }}
```

**generated `.yml`** — splits into a setup job (compact JSON via heredoc) and the
matrix job (`needs` + `fromJSON` + `fail-fast: false` + empty-matrix guard):
```yaml
jobs:
  actio_setup_test:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.actio_eval.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4
      - name: Evaluate dynamic matrix
        id: actio_eval
        run: |-
          {
            echo 'matrix<<ACTIO_EOF'
            ./scripts/list.sh | jq -c .
            echo ACTIO_EOF
          } >> "$GITHUB_OUTPUT"
  test:
    runs-on: ubuntu-latest
    needs: [actio_setup_test]
    strategy:
      matrix:
        shard: ${{ fromJSON(needs.actio_setup_test.outputs.matrix) }}
      fail-fast: false
    if: needs.actio_setup_test.outputs.matrix != '[]' && needs.actio_setup_test.outputs.matrix != ''
    steps:
      - run: ./run-shard.sh ${{ matrix.shard }}
```

Options: `script` (required), `alias` (wrap a scalar array under `matrix.<alias>`;
omit for raw `{include:[...]}` mode), `checkout` (default `true` when `script` is
a local path), `runs-on`, `shell`, `compact` (default `true`), `fail-fast` (default
`false`), `id`.

`script` can be a path **or** an inline command — single- or multi-line. Inline
scripts skip the auto-checkout (set `checkout: true` if yours reads the repo):

```yaml
dynamic_matrix:
  alias: pkg
  checkout: true
  script: |
    ls -d packages/*/ | xargs -n1 basename | jq -Rcn '[inputs]'
```

`shell:` works like a step's `shell` and picks the interpreter for `script`.
Supported: `bash`/`sh` (heredoc + `jq`), `pwsh`/`powershell` (captured pipeline
output, BOM-free), and `python` (captured stdout). Actio emits matching plumbing
to publish the matrix output, so a PowerShell or Python generator just prints its
JSON. `compact` (jq) is bash/sh-only; other shells emit raw multi-line JSON, which
`fromJSON()` parses fine.

### 4. `fallback`

A native try/catch. Attach `fallback:` to a step (or a job).

**Default = notify** (the error is *not* swallowed; fallback runs via
`if: failure()`, the job still fails):

**`.actio.yml`**
```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        run: ./deploy.sh
        fallback:
          - name: Notify
            run: ./notify.sh failure
```

**generated `.yml`** — the guarded step gets an `id`; the fallback is gated on its
`conclusion`:
```yaml
steps:
  - name: Deploy
    run: ./deploy.sh
    id: step_deploy
  - name: Notify
    run: ./notify.sh failure
    if: failure() && steps.step_deploy.conclusion == 'failure'
```

**`recover: true`** = true try/catch: the guarded step gets
`continue-on-error: true` and the fallback uses `steps.<id>.outcome == 'failure'`,
so the job can continue.

> The `outcome` vs `conclusion` distinction matters: with `continue-on-error`, a
> failed step's `conclusion` becomes `success`, so recovery must key off
> `outcome`. Actio gets this right for you.

## CLI

```
actio build [...files]   Compile .actio.yml files into GitHub Actions workflows
actio watch [...files]   Watch .actio.yml files and rebuild on change
actio check [...files]   Verify generated workflows are up to date (= build --check)
actio init [file]        Scaffold a starter .actio.yml file
actio schema             Print the Actio JSON Schema (--out <file> to save locally)
```

`build` options:

| Flag | Description |
| --- | --- |
| `--config <file>` | Path to an actio config file (overrides auto-discovery) |
| `--out-dir <dir>` | Output directory (default `.github/workflows`) |
| `--check` | Verify output is up to date without writing (CI drift check) |
| `--stdout` | Write generated YAML to stdout instead of files |
| `-w, --watch` | Rebuild on change and keep running (like `tsc --watch`) |
| `--no-validate` | Skip schema validation of generated output |
| `--no-header` | Omit the generated-by-Actio banner |
| `--no-source-map` | Do not write a `.yml.map` source map beside each workflow |

## Source maps

`build` writes a sidecar `<name>.yml.map` next to each generated workflow (opt
out with `--no-source-map`; `--stdout` never emits one). It maps **generated
lines back to `.actio.yml` source positions**, so when a line fails — in a real
Actions run or in our own schema validation — the error can point at the source
you actually wrote instead of machine-generated YAML.

The format is a small, line-oriented JSON (Source Map v3-ish field names, no VLQ,
no inline comments — the generated YAML stays byte-for-byte unchanged):

```jsonc
{
  "version": 1,
  "generator": "actio",
  "file": "ci.yml",              // generated workflow
  "sources": ["ci.actio.yml"],   // original source(s)
  "mappings": [                  // sparse: only confidently-resolved lines
    { "generated": { "line": 12 }, "source": 0, "original": { "line": 5, "col": 7 }, "path": "jobs.test.steps.0" }
  ]
}
```

Mappings are **reconstructed at emit time** rather than threaded through the
passes: the emitted YAML is re-parsed for generated line numbers, and each node
is resolved back to its source through the typed IR's provenance side-table.
`originOf` returns a node's **true source range even after a macro moved it** (a
fragment-injected step, a retry-fanned attempt, the `dynamic_matrix` setup job),
because the IR pins each origin before mutation and carries it across clones.
Nodes the IR never tracks (top-level keys, job scalars) fall back to their range
at the final path — exact, since they never move — and genuinely synthetic lines
(the banner, eval plumbing) are simply left unmapped. `buildSourceMap` (in
[`packages/core/src/sourcemap.ts`](packages/core/src/sourcemap.ts)) resolves
every node through one `makeResolveOrigin` seam, so the format, `transpile`, and
the CLI are independent of how provenance is sourced.

The library exposes this too: `transpile(source, { sourceMap: true })` returns a
`map` field, and with it on, schema-validation diagnostics are remapped back to
source ranges so code frames line up with your `.actio.yml`.

### Watch mode

`actio build --watch` (or the standalone `actio watch`) does a full build, then
watches your `.actio.yml` files — and the surrounding directories, so brand-new
files are picked up too — and rebuilds the changed file on save. Saves are
debounced, each rebuild prints a timestamped summary, and a transpile error is
reported without ever stopping the watcher (exit code stays `0`). Press `Ctrl+C`
to stop.

## Editor support

Actio ships a JSON Schema for `.actio.yml`, so the [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) (which bundles `yaml-language-server`) gives you autocomplete, hover docs, and validation for the macro keywords — no custom language server required.

Add this modeline to the top of any `.actio.yml` file (`actio init` adds it for you):

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/austenstone/actio/main/packages/core/schema/actio.schema.json
```

Prefer a pinned local copy? Write one and point the modeline at it:

```bash
actio schema --out .actio.schema.json
# then: # yaml-language-server: $schema=./.actio.schema.json
```

The schema is also exported from `@actio/core` (`actioSchema()`, `actioSchemaPath`, `ACTIO_SCHEMA_URL`, `SCHEMA_MODELINE`).

## Configuration

For anything beyond flags — and to register **custom passes** — drop an
`actio.config` file in your project. Actio auto-discovers it by walking up from
the current directory, so it works from any subfolder. Point at a specific file
with `--config <file>` to skip discovery (handy when the config lives somewhere
discovery won't reach, like alongside your sources). Supported formats:
`actio.config.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.json` (TS/ESM are
loaded at runtime via [jiti](https://github.com/unjs/jiti) — no build step).

```ts
// actio.config.ts
import { defineConfig } from "@actio/core"; // also re-exported from "@actio/cli/config"

export default defineConfig({
  outDir: ".github/workflows",
  validate: true,
  header: true,
  files: ["**/*.actio.yml"], // `include` is accepted as an alias
  passes: [],                // custom transform passes (see below)
});
```

`defineConfig()` is an identity helper — it exists purely for type-safe
authoring and autocompletion.

| Field | Type | Description |
| --- | --- | --- |
| `outDir` | `string` | Output directory for generated workflows |
| `validate` | `boolean` | Validate generated YAML against GitHub's schema |
| `header` | `boolean` | Prepend the generated-by-Actio banner |
| `files` / `include` | `string[]` | Default glob patterns when no files are passed on the CLI |
| `passes` | `Pass[]` | Custom transform passes, merged into the built-in pipeline |

### Precedence

Settings resolve **explicit CLI flag → config file → built-in default**, in that
order. Passing `--out-dir build/` always wins over the config's `outDir`, which
in turn wins over the `.github/workflows` default. Positional file globs on the
CLI override `files`/`include` from the config.

### Custom passes

The `passes` field is the headline feature: a pass you supply is **merged** into
the built-in pipeline (not replacing it), and the final order is still derived by
topologically sorting every pass's `runsAfter` — so your pass slots in wherever
its dependencies say it should. A pass is a `{ name, runsAfter?, apply }`
descriptor; `apply(ctx)` mutates `ctx.data` (the parsed workflow object) in place.

```ts
// actio.config.ts
import { defineConfig, type Pass } from "@actio/core";

// Stamp a global env var onto every generated workflow.
const stampEnv: Pass = {
  name: "stamp-env",
  runsAfter: ["fragments"],
  apply: (ctx) => {
    ctx.data.env = { BUILT_BY: "actio", ...(ctx.data.env as object) };
  },
};

export default defineConfig({
  passes: [stampEnv],
});
```

Now `actio build` runs `stampEnv` as part of the pipeline — no fork of core
required. Pass names must be unique (Actio throws on a collision with a
built-in or another custom pass).

> **Traversing jobs and steps?** Prefer the typed-IR **visitor helpers** —
> `workflow`, `visitJobs`, `visitSteps`, `transformSteps`, all exported from
> `@actio/core` — over poking `ctx.data` by hand. They give you typed nodes and
> handle the awkward shape-checking for you. (These land with the
> [typed-IR PR (#10)](https://github.com/austenstone/actio/pull/10); on older
> versions, fall back to walking `ctx.data` as above.)

```ts
// Preferred form once the typed-IR API is available.
import { defineConfig, transformSteps, type Pass } from "@actio/core";

// Pin every actions/checkout to a specific SHA.
const pinCheckout: Pass = {
  name: "pin-checkout",
  runsAfter: ["fragments"],
  apply: (ctx) =>
    transformSteps(ctx, (step) =>
      step.uses?.startsWith("actions/checkout@")
        ? { ...step, uses: "actions/checkout@<sha>" }
        : step,
    ),
};

export default defineConfig({ passes: [pinCheckout] });
```

## How it works

```
actio build [globs]
  discover .actio.yml files
  per file:
    1. parse with eemeli `yaml` (comment- and position-preserving)
    2. run transform passes in dependency order: fragments → retry → fallback → dynamic_matrix
    3. serialize back to standard YAML (block scalars preserved)
    4. prepend a "generated by Actio" header
    5. validate the OUTPUT with @actions/workflow-parser (official GHA schema)
    6. write .github/workflows/<name>.yml + <name>.yml.map  (or --stdout / --check)
```

- **Front-end:** [eemeli `yaml`](https://github.com/eemeli/yaml) v2 — permissive,
  round-trippable, preserves `run: |` block scalars. (The official parser
  validates during parse and would reject our macro keywords.)
- **Output validation:** [`@actions/workflow-parser`](https://github.com/actions/languageservices/tree/main/workflow-parser)
  — the same parser behind the [GitHub Actions language server](https://github.com/actions/languageservices).
  Every generated workflow is fed back through it, so Actio only ever emits a
  legal workflow.

Each transform is a **pass** — a `{ name, runsAfter?, apply }` descriptor in
[`packages/core/src/passes`](packages/core/src/passes). The pipeline order is
derived by topologically sorting each pass's `runsAfter`, not hand-maintained, so
adding a feature is: drop in a new file, declare what it runs after, register it.
`PassRegistry` (exported from `@actio/core`) lets external code add or remove
passes without editing core.

### Typed IR and provenance

Passes operate on a small **typed IR** ([`packages/core/src/ir.ts`](packages/core/src/ir.ts))
that wraps `ctx.data` rather than replacing it — the emitted YAML stays
byte-for-byte identical. `workflow(ctx)`, `visitJobs`, `visitSteps`, and the
in-place `transformSteps` fan-out helper give passes (and third-party plugins)
typed `Job`/`Step` views instead of raw `Record<string, any>`.

Every node can carry an **origin** — the source path/range it came from — held in
a `WeakMap` side-table (`ctx.origins`) keyed by object identity, so it survives
index shifts and never serializes. The visitor records origins on first sight;
`cloneNode` and `deriveNode` propagate them so generated nodes (retry attempts and
sleep steps, the `dynamic_matrix` setup job) map back to their macro source. This
is the hook source maps build on. Look up an origin with `originOf(ctx, node)`.

## Packages

| Package | Description |
| --- | --- |
| [`@actio/core`](packages/core) | The engine: parse, passes, emit, validate, diagnostics |
| [`@actio/cli`](packages/cli) | The `actio` binary (wraps core) |

A programmatic TypeScript API on `@actio/core` is planned.

## Development

```bash
npm install
npm run build      # tsup, both packages
npm test           # vitest
npm run lint       # biome
npm run typecheck  # tsc --noEmit
```

Golden fixtures live in [`tests/fixtures/<case>/`](tests/fixtures) as
`input.actio.yml` + `expected.yml`. Every `expected.yml` must pass
`@actions/workflow-parser` — we only ever assert on legal workflows.

## License

[MIT](LICENSE) © Austen Stone

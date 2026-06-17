# Actio

> A transpiler that compiles a clean `.actio.yml` source into the verbose GitHub Actions YAML you'd otherwise hand-write.

Writing **dynamic** GitHub Actions workflows in raw YAML is painful. Actio adds a
small set of macro keywords — [`fragments`](#1-fragments--inject),
[`dynamic_matrix`](#2-dynamic_matrix), and [`fallback`](#3-fallback) — that
expand into the boilerplate GitHub requires. Everything else is passthrough, so a
macro-free `.actio.yml` file is just a normal workflow.

Inspired by [Buildkite](https://buildkite.com/docs/pipelines/configure/dynamic-pipelines)'s
runtime `pipeline upload`. GitHub Actions can't inject steps at runtime — but we
**can** generate the correct YAML ahead of time from a higher-level source.

## Why

| Pain in raw YAML | Actio |
| --- | --- |
| Dynamic matrix needs a hand-built setup job that prints JSON to `$GITHUB_OUTPUT`, consumed downstream via `fromJSON()`, with escaping and empty-guard gotchas | `dynamic_matrix: { script, alias }` |
| Reusing 3 steps forces a separate [composite action](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action) or [reusable workflow](https://docs.github.com/en/actions/sharing-automations/reusing-workflows) file | in-file `fragments` + `inject` |
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

### 2. `dynamic_matrix`

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
a local path), `runs-on`, `shell`, `fail-fast` (default `false`), `id`.

### 3. `fallback`

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
actio check [...files]   Verify generated workflows are up to date (= build --check)
actio init [file]        Scaffold a starter .actio.yml file
```

`build` options:

| Flag | Description |
| --- | --- |
| `--out-dir <dir>` | Output directory (default `.github/workflows`) |
| `--check` | Verify output is up to date without writing (CI drift check) |
| `--stdout` | Write generated YAML to stdout instead of files |
| `--no-validate` | Skip schema validation of generated output |
| `--no-header` | Omit the generated-by-Actio banner |

## How it works

```
actio build [globs]
  discover .actio.yml files
  per file:
    1. parse with eemeli `yaml` (comment- and position-preserving)
    2. run ordered transform passes: fragments → fallback → dynamic_matrix
    3. serialize back to standard YAML (block scalars preserved)
    4. prepend a "generated by Actio" header
    5. validate the OUTPUT with @actions/workflow-parser (official GHA schema)
    6. write .github/workflows/<name>.yml  (or --stdout / --check)
```

- **Front-end:** [eemeli `yaml`](https://github.com/eemeli/yaml) v2 — permissive,
  round-trippable, preserves `run: |` block scalars. (The official parser
  validates during parse and would reject our macro keywords.)
- **Output validation:** [`@actions/workflow-parser`](https://github.com/actions/languageservices/tree/main/workflow-parser)
  — the same parser behind the [GitHub Actions language server](https://github.com/actions/languageservices).
  Every generated workflow is fed back through it, so Actio only ever emits a
  legal workflow.

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

# AGENTS.md

Context for coding agents (Copilot, Claude Code, Cursor, …) working with **Actio**.

Actio is a transpiler that compiles a clean `.actio.yml` source (a strict superset
of GitHub Actions workflow YAML) into the verbose standard workflow YAML you'd
otherwise hand-write. Macros expand at **compile time**; nothing survives into the
generated output, so there is no runtime and no lock-in. A macro-free `.actio.yml`
file is already a valid workflow.

- Docs: https://austenstone.github.io/actio
- Repo: https://github.com/austenstone/actio
- License: MIT

## Installation

Requires **Node ≥ 20**.

```bash
npm install -D actio-cli
```

Or run once without installing:

```bash
npx actio-cli build
```

## Usage

```bash
actio init [file]        # Scaffold a starter .actio.yml file
actio build [...files]   # Compile .actio.yml -> .github/workflows/*.yml
actio watch [...files]   # Rebuild on change (like tsc --watch)
actio check [...files]   # CI drift check: fail if generated output is stale
actio schema             # Print the Actio JSON Schema (--out <file> to save)
```

Recommended layout — keep sources in `.github/actio/` and treat
`.github/workflows/` as your committed `dist` (GitHub only runs what's there):

```text
.github/
  actio/        # source: *.actio.yml (+ actio.config.ts)
  workflows/    # generated: *.yml (commit these; actio check keeps them honest)
```

Key `build` flags: `--config <file>`, `--out-dir <dir>`,
`--target <legacy|github-actions-native-dependencies-preview>`, `--check`,
`--stdout`, `-w/--watch`, `--no-validate`, `--no-header`, `--no-source-map`,
`--no-annotate`.

## Configuration

Drop an `actio.config` file in the project (auto-discovered by walking up; or pass
`--config <file>`). Formats: `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.json`
(TS/ESM loaded at runtime via jiti — no build step).

```ts title="actio.config.ts"
import { defineConfig } from "actio-core"; // also re-exported from "actio-cli/config"

export default defineConfig({
  outDir: ".github/workflows",
  validate: true,
  header: true,
  target: "legacy",
  files: ["**/*.actio.yml"], // `include` is an accepted alias
  passes: [],                // custom transform passes, merged into the pipeline
});
```

Precedence: explicit CLI flag → config file → built-in default.

Custom passes are merged into (not replacing) the built-in pipeline; ordering is
derived by topologically sorting each pass's `runsAfter`. A pass is
`{ name, runsAfter?, apply }` where `apply(ctx)` mutates `ctx.data` in place.
Prefer the typed-IR visitor helpers (`workflow`, `visitJobs`, `visitSteps`,
`transformSteps`, exported from `actio-core`) over poking `ctx.data` by hand.

## Macros (the keywords Actio adds)

Interpolation: `{{ ... }}` is **compile-time** (resolved by `actio build`);
`${{ ... }}` is **runtime passthrough** (emitted verbatim for the runner).

| Group | Keyword(s) | What it does |
| --- | --- | --- |
| **Reuse** | `_anchors` + `- *alias` | Native YAML anchor library; the aliased step list is flattened in place. Preferred for same-file, no-param reuse |
| | `templates` + `inject … with` | Named parameterized step lists; typed compile-time args |
| | `inject: ./lib#name` | Cross-file step/job reuse from imported templates/modules |
| | `fragments` + `inject` | **Deprecated** (lint `fragment-deprecated`): same-file step lists. Prefer `_anchors`/`templates` |
| | `reusable` | Author one workflow that's both `workflow_call` + `workflow_dispatch`; inputs derived once |
| | `call-templates` + `extends` | Named reusable-workflow call presets (`uses`/`with`/`needs`/`secrets`/`if`); jobs `extends:` and override deltas |
| **Config presets** | `params` | Typed compile-time inputs; reference with `{{ params.* }}` |
| | `job-defaults` | Job-level defaults merged into every job |
| | `executors` + `executor` | Named runner/container/service presets |
| **Matrix** | `dynamic-matrix` | Generate `strategy.matrix` at runtime from a script |
| | `expand-matrix` | Unroll a literal matrix into named static jobs at compile time |
| | `for-each` | Repeat a step (or job) over a list |
| **Reliability** | `retry` | Retry a flaky step with optional backoff |
| | `fallback` | Native try/catch (notify, or `recover: true`) |
| | `soft-fail` | `continue-on-error`, or a build-time exit-code allow-list |
| | `lifecycle` (`ensure`/`on-success`/`on-failure`/`on-abort`) | Guarded teardown/outcome hooks (`always()`/`success()`/`failure()`/`cancelled()`) |
| **Wiring** | `share` | Promote step outputs to `job.outputs` + auto-wire `needs` |
| | `ref` | Infer the producer job; wire `job.outputs` + `needs` |
| **Conditionals** | `static-if` | Compile-time conditional; drops the node when false |
| | `if-changed` | Gate a step/job on changed paths (synthesizes a `paths-filter` job) |
| **Security** | `injection-hoist` | Defuse script injection: hoist untrusted `${{ }}` out of `run:` into `env:` |
| **Artifacts** | `artifacts` | Append an `actions/upload-artifact` step |

Full keyword dictionary (incl. `let`, `coercion`, `finally`, and the per-step hoist
overrides `unsafe`/`trust`/`force`): see the
[syntax reference](https://austenstone.github.io/actio/docs/syntax).

```yaml title=".actio.yml"
params:
  env: { type: enum, values: [dev, staging, prod], default: staging }
_anchors:
  setup: &setup
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - *setup
      - run: echo "deploying to {{ params.env }}"
        retry: { attempts: 3, delay: 10s }
```

## Repo development

Monorepo (npm workspaces): `packages/core` (compiler), `packages/cli`,
`.github/actions/*`. Node ≥ 20.

```bash
npm install
npm run build       # build core + cli + action
npm test            # vitest
npm run typecheck
npm run lint        # biome
```

Standards: TypeScript, functional patterns, `camelCase`, KISS, minimal comments
(explain *why*, not *what*). The repo's own workflows are authored in Actio under
`.github/actio/` and compiled into `.github/workflows/`.

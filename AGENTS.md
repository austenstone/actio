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

| Keyword | Scope | What it does |
| --- | --- | --- |
| `params` | workflow | Typed compile-time inputs; reference with `{{ params.* }}` |
| `fragments` + `inject` | workflow / step | Reusable named step lists, spliced in with `- inject: <name>` |
| `job_defaults` | workflow | Job-level defaults merged into every job |
| `executors` + `executor` | workflow / job | Named runner/container/service presets |
| `dynamic_matrix` | job | Generate `strategy.matrix` at runtime from a script |
| `static_if` | job, step | Compile-time conditional; drops the node when false |
| `retry` | step | Retry a flaky step with optional backoff |
| `fallback` | job, step | Native try/catch (notify, or `recover: true`) |

```yaml title=".actio.yml"
params:
  env: { type: enum, values: [dev, staging, prod], default: staging }
fragments:
  setup:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - inject: setup
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

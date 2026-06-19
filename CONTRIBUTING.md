# Contributing to Actio

Actio is a transpiler. The dangerous failure mode is not a crash, it is silently wrong GitHub Actions YAML. New macro work must prove behavior before implementation, stay fully typed, and keep the gate green.

## TDD-first macro workflow

1. Start RED with golden fixtures. Add `tests/fixtures/<macro-case>/input.actio.yml` and `expected.yml` before implementing the pass.
2. Add diagnostic tests for invalid inputs before implementation. Every error-table row in the macro's spec issue needs a matching `tests/diagnostics.test.ts` case.
3. Implement the pass in `packages/core/src/passes/` only after the fixture and diagnostic tests fail for the right reason.
4. Iterate to GREEN with `npm test`, then run the standard PR gate before opening a PR.

## Fully typed expectations

- No explicit `any`. Use `unknown`, type guards, discriminated unions, or typed helpers.
- Keep `noUncheckedIndexedAccess` clean. Treat indexed map and array reads as possibly missing.
- Model new IR shapes as discriminated unions when a macro introduces structured variants. Narrow by `kind` before reading variant-specific fields.
- Prefer existing helpers in `packages/core/src/ir.ts` and `packages/core/src/passes/helpers.ts` over ad hoc casts.
- Preserve source origins with `cloneNode`, `deriveNode`, and `recordOrigin` when cloning, deriving, or moving workflow nodes.

## Pass ordering

Pass order is data-driven with `runsAfter`, not array position. The locked macro pipeline is:

`params (#17) -> job_defaults (#21) -> for_each/dynamic_matrix (#20) -> when_compile (#23) -> fragments/inject (shipped) -> share (#18) -> lifecycle (#24) -> injection-hoist (#22) -> annotate (last)`

`pins (#19)` is orthogonal at emit. Build DAG tiers are `T0 = #17, #19`, `T1 = #23, #21`, `T2 = #20, #18`, and `T3 = #24, #22`.

## Per-macro Definition of Done

- [ ] Pass file added in `packages/core/src/passes/`.
- [ ] `runsAfter` wired to the locked pipeline order above.
- [ ] JSON-schema extension added under `packages/core/schema/`.
- [ ] Golden fixtures cover happy paths and edge cases.
- [ ] Diagnostic test exists for each error-table row in the macro's spec issue.
- [ ] Source-map mappings cover emitted jobs and steps introduced or moved by the macro.
- [ ] At least one composition test covers interaction with another macro.
- [ ] README or docs section explains user-facing syntax and emitted Actions YAML.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] `npm run test:coverage` passes.
- [ ] `npm run build:workflows && npm run check:workflows` passes when workflow sources changed.

## Gate commands

Run these locally before requesting review:

```sh
npm run lint
npm run typecheck
npm run build
npm test
npm run test:coverage
npm run check:workflows
npm run test:lint:workflows   # needs Docker; runs actionlint over emitted workflows
```

If you edit `.github/actio/*.actio.yml`, do not hand-edit `.github/workflows/*.yml`. Run `npm run build:workflows`, commit the generated workflow and map, then run `npm run check:workflows`.

## End-to-end tests on real GitHub Actions

The golden tests only prove transpile-time correctness (byte-match + schema). The
e2e harness proves the emitted YAML is **accepted and executed correctly by
GitHub Actions** — including the behavioral runtime sugar (`retry`, `fallback`,
`dynamic_matrix`) that a static diff can't verify.

It's fully dogfooded: the fixtures **and** the driver are authored as `.actio.yml`
and compiled by Actio's own CLI. If the emitter breaks, the harness fails to build.

- **Fixtures** — [`.github/actio/e2e/*.actio.yml`](.github/actio/e2e) compile to
  reusable workflows (`on: [workflow_call, workflow_dispatch]`). Each one is
  self-contained (bash + jq only, no `npm`/repo scripts) and **self-asserting**:
  it ends green only when the feature behaved correctly, even the failure-path
  ones (e.g. `e2e-retry` fails attempt 1 via a marker file, then passes attempt 2).
- **Driver** — [`.github/actio/e2e.actio.yml`](.github/actio/e2e.actio.yml)
  compiles to `e2e.yml`. It runs a `check` job (build + `check:workflows`), one
  caller job per fixture via `uses: ./.github/workflows/e2e-<name>.yml`, and a
  `result` gate job (`if: always()`) that fails unless every fixture succeeded.
- **Triggers** — `workflow_dispatch` (manual), nightly `schedule`, and
  path-filtered `pull_request` (only when emit-relevant paths change), so
  everyday PRs stay cheap.
- **actionlint tier** — `npm run test:lint:workflows` runs GitHub's own workflow
  parser (pinned `rhysd/actionlint:1.7.12`, via Docker) over every emitted
  `.github/workflows/*.yml`, catching `if:`/`needs:`/matrix mistakes the JSON
  schema is too loose to flag. Wired into CI as the `lint-workflows` job.

### Running it

```sh
gh workflow run e2e.yml --ref <your-branch>   # whole suite
gh workflow run e2e-retry.yml --ref <branch>  # a single fixture
gh run watch --exit-status                     # follow to green/red
```

> **Expected wart:** the `e2e-fallback-notify` run surfaces one red error
> annotation while still concluding green. The deploy job fails on purpose
> (job-level `continue-on-error`), so the auto-injected `actio-annotate` job runs
> and annotates that intentional failure. The workflow result is success — that
> annotation is honest dogfooding, not a real failure.

# Contributing to Actio

Actio is a transpiler. The dangerous failure mode is not a crash, it is silently wrong GitHub Actions YAML. New macro work must prove behavior before implementation, stay fully typed, and keep the gate green.

## TDD-first macro workflow

1. Start RED with golden fixtures. Add `tests/fixtures/<macro-case>/input.actio.yml` and `expected.yml` before implementing the pass.
2. Add diagnostic tests for invalid inputs before implementation. Every error-table row in the macro's spec issue needs a matching `tests/diagnostics.test.ts` case.
3. Implement the pass in `packages/core/src/passes/` only after the fixture and diagnostic tests fail for the right reason.
4. Iterate to GREEN with `npm test`, then run the full gate before opening a PR.

Coverage proves code ran. Mutation testing proves the assertions bite. For a YAML transpiler, mutation testing is the load-bearing TDD gate because it catches tests that snapshot happy paths without detecting wrong conditions, missing branches, or subtly incorrect emitted YAML.

The canonical mutation threshold lives in `stryker.config.json`; the current `break` threshold is 62%. A PR can fail mutation testing even with 100% line coverage if it deletes or weakens a load-bearing assertion. Treat that as the gate working, not as a flaky coverage check.

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
- [ ] `npm run test:mutation` passes.
- [ ] `npm run build:workflows && npm run check:workflows` passes when workflow sources changed.

## Gate commands

Run these locally before requesting review:

```sh
npm run lint
npm run typecheck
npm run build
npm test
npm run test:coverage
npm run test:mutation
npm run check:workflows
```

If you edit `.github/actio/*.actio.yml`, do not hand-edit `.github/workflows/*.yml`. Run `npm run build:workflows`, commit the generated workflow and map, then run `npm run check:workflows`.

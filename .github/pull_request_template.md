## What changed


## Macro Definition of Done

- [ ] Pass file added in `packages/core/src/passes/`.
- [ ] `runsAfter` wired to the locked pipeline order in `CONTRIBUTING.md`.
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

## Notes


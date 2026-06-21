## Summary

<!-- What changed and why. One or two sentences is plenty. -->

## Docs

`tests/docs-completeness.test.ts` fails the build if a user-facing surface ships
without docs. Check the boxes that apply (or note why they don't):

- [ ] New/changed built-in pass → `docs/content/docs/macros/<name>.mdx` (scaffold it with `npm run docs:new <name>`, then add the slug to `macros/meta.json`)
- [ ] New/changed `ActioConfig` key → documented in `docs/content/docs/configuration.mdx`
- [ ] New/changed CLI command → documented in `docs/content/docs/cli.mdx`
- [ ] `npm run docs:build` passes

## Checklist

- [ ] Tests / fixtures updated
- [ ] `npm test` and `npm run lint` pass
- [ ] `npm run build:workflows && npm run check:workflows` (only if `.github/actio/*` changed)

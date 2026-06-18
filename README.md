# Actio

> A transpiler that compiles a clean `.actio.yml` source into the verbose GitHub Actions YAML you'd otherwise hand-write.

📖 **[Read the documentation →](https://austenstone.github.io/actio)**

Writing **dynamic** GitHub Actions workflows in raw YAML is painful. Actio adds a
small set of macro keywords (`params`, `fragments`, `retry`, `dynamic_matrix`,
`fallback`) that expand into the boilerplate GitHub requires. Everything else is
passthrough, so a macro-free `.actio.yml` file is just a normal workflow.

## Quickstart

```bash
npm install -D actio-cli

npx -p actio-cli actio init ci.actio.yml   # scaffold a starter source file
npx -p actio-cli actio build               # compile *.actio.yml → .github/workflows/*.yml
npx -p actio-cli actio check               # CI drift check (fails if output is stale)
```

Requires Node ≥ 20. Full walkthrough in the
[Quickstart guide](https://austenstone.github.io/actio/docs/quickstart).

## Documentation

Everything lives at **[austenstone.github.io/actio](https://austenstone.github.io/actio)**:

- [Installation](https://austenstone.github.io/actio/docs/installation) · [Quickstart](https://austenstone.github.io/actio/docs/quickstart)
- Macros: [`params`](https://austenstone.github.io/actio/docs/macros/params) · [`fragments`](https://austenstone.github.io/actio/docs/macros/fragments) · [`retry`](https://austenstone.github.io/actio/docs/macros/retry) · [`dynamic_matrix`](https://austenstone.github.io/actio/docs/macros/dynamic-matrix) · [`fallback`](https://austenstone.github.io/actio/docs/macros/fallback)
- [CLI reference](https://austenstone.github.io/actio/docs/cli) · [Configuration](https://austenstone.github.io/actio/docs/configuration)
- [Supply-chain pinning](https://austenstone.github.io/actio/docs/supply-chain)
- [Source maps](https://austenstone.github.io/actio/docs/source-maps) · [Editor support](https://austenstone.github.io/actio/docs/editor-support)
- [Architecture](https://austenstone.github.io/actio/docs/architecture)

## Packages

| Package | Description |
| --- | --- |
| [`actio-core`](packages/core) | The engine: parse, passes, emit, validate, diagnostics |
| [`actio-cli`](packages/cli) | The `actio` binary (wraps core) |

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
[`@actions/workflow-parser`](https://github.com/actions/languageservices), so we
only ever assert on legal workflows.

The documentation site is a separate [Fumadocs](https://www.fumadocs.dev/) app in
[`docs/`](docs); see its [README](docs/README.md) to run it locally.

## License

[MIT](LICENSE) © Austen Stone

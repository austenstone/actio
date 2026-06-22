# actio-cli

> Compile clean GitHub Actions YAML — a handful of compile-time macros — into the
> verbose workflow YAML you'd otherwise hand-write. Zero runtime, zero lock-in.

Part of [Actio](https://github.com/austenstone/actio).

## Install

```bash
npm install -D actio-cli
# or run without installing:
npx actio-cli build
```

Requires Node ≥ 20.

## Quickstart

```bash
# scaffold a starter source file
npx actio-cli init ci.actio.yml

# compile *.actio.yml → .github/workflows/*.yml
npx actio-cli build

# CI drift check (fails if generated output is stale)
npx actio-cli check
```

See the [full documentation](https://austenstone.github.io/actio) for
macros (`dynamic-matrix`, `retry`, `fallback`, `params`), config, and the
custom-pass API.

## License

[MIT](./LICENSE) © Austen Stone

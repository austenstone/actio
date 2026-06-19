# actio-cli

> The `actio` command — compile clean `.actio.yml` sources into the verbose
> GitHub Actions workflow YAML you'd otherwise hand-write.

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

See the [full documentation](https://github.com/austenstone/actio#readme) for
macros (`fragments`, `retry`, `dynamic-matrix`, `fallback`), config, and the
custom-pass API.

## License

[MIT](./LICENSE) © Austen Stone

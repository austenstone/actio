# actio-core

> The Actio transpiler engine — parse, transform, emit, and validate `.actio.yml`
> (a GitHub Actions YAML superset) into standard workflow YAML.

`actio-core` is the engine behind [Actio](https://github.com/austenstone/actio).
It exposes the compiler API (passes, emit, diagnostics) and the Actio JSON schema
for wiring Actio into your own tooling.

Most users want the [`actio-cli`](https://www.npmjs.com/package/actio-cli)
command-line tool instead.

## Install

```bash
npm install actio-core
```

Requires Node ≥ 20.

## Usage

```ts
import { defineConfig, transformSteps, type Pass } from "actio-core";
```

See the [full documentation and API reference](https://github.com/austenstone/actio#readme).

## License

[MIT](./LICENSE) © Austen Stone

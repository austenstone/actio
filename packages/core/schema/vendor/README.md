# Vendored: official GitHub Actions workflow schema

`github-workflow.json` is a snapshot of the official GitHub Actions workflow
schema from [SchemaStore](https://www.schemastore.org/):

- Source: <https://json.schemastore.org/github-workflow.json>
- License: Apache-2.0 (SchemaStore)

Actio inherits this wholesale so `.actio.yml` files get full autocomplete and
validation for every standard GitHub Actions key, event, runner, and context —
without re-deriving the workflow schema by hand.

## Do not edit

This file is a verbatim upstream snapshot. To pull the latest version:

```sh
npm run schema:refresh -w actio-core
```

That fetches the current upstream schema into this file and regenerates
`../actio.schema.json`. The Actio macro layer lives in
`../actio.extensions.json`; the merge happens in `../../scripts/build-schema.mjs`.

import { SCHEMA_MODELINE } from "@actio/core";

export const STARTER_ACTIO = `${SCHEMA_MODELINE}
name: CI
on: [push]

fragments:
  setup_node:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - inject: setup_node
      - name: Test
        run: npm ci && npm test
`;

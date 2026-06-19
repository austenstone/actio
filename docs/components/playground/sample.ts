export const sampleSource = `name: Fragments
on: [push]

# Define a reusable block of steps once...
fragments:
  setup:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      # ...then inject it anywhere. Actio expands this at build time.
      - inject: setup
      - run: npm test
`;

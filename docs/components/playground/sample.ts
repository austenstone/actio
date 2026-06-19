export const sampleSource = `name: Actio Kitchen Sink

on: [push, pull_request, workflow_dispatch]

injection-hoist: fix

params:
  node:
    type: number
    default: 22
  channel:
    type: enum
    values: [canary, beta, stable]
    default: canary
  preview:
    type: boolean
    default: true
  services:
    type: object
    default: [api, web, worker]

job-defaults:
  runs-on: ubuntu-latest
  timeout-minutes: 20
  permissions:
    contents: read
  env:
    CI: "true"
    CHANNEL: "{{ params.channel }}"
  defaults:
    run:
      shell: bash

executors:
  node:
    env:
      NODE_ENV: test
  cache:
    services:
      redis:
        image: redis:7
        ports: ["6379:6379"]

fragments:
  setup:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: "{{ params.node }}"
        cache: npm
    - run: npm ci
      retry:
        attempts: 3
        delay: 10s

call-templates:
  reusable-check:
    uses: ./.github/workflows/check.yml
    needs: build
    secrets: inherit
    with:
      node: "{{ params.node }}"
      channel: "{{ params.channel }}"

jobs:
  plan:
    executor: node
    steps:
      - inject: setup
      - name: Resolve version
        run: VERSION=$(jq -r .version package.json)
        share:
          version:
            value: $VERSION
            required: true
      - name: Plan deploy metadata
        share:
          deploy:
            run: jq -nc '{env:"preview", region:"iad"}'
            json: true
            type: object
      - run: echo "PR title is \${{ github.event.pull_request.title }}"

  build:
    executor: [node, cache]
    needs: plan
    if-changed: [src/**, packages/**, package-lock.json]
    steps:
      - inject: setup
      - for-each:
          var: service
          in: params.services
        steps:
          - run: npm run build --workspace {{ service }}
      - run: npm run build
        fallback:
          retry:
            runs-on: ubuntu-latest-8-cores
            when-exit-code: [137, 143]
    ensure:
      - run: docker compose down --remove-orphans || true

  test:
    needs: build
    dynamic-matrix:
      alias: shard
      script: echo '["unit","integration","e2e"]'
    steps:
      - inject: setup
      - run: npm test -- --shard \${{ matrix.shard }}
        fallback:
          recover: true
          steps:
            - run: echo "collecting diagnostics"

  docs:
    static-if: params.preview
    if-changed: [docs/**, README.md]
    steps:
      - inject: setup
      - run: npm run docs:build

  preview:
    needs: test
    static-if: params.preview
    if: github.event_name == 'pull_request'
    environment:
      name: preview
      url: https://preview.example.com/\${{ share.version }}
    steps:
      - inject: setup
      - run: ./scripts/deploy-preview.sh "\${{ share.deploy.env }}" "\${{ share.deploy.region }}"

  reusable-unit:
    extends: reusable-check
    with:
      name: unit
      command: npm test -- --suite unit

  reusable-integration:
    extends: reusable-check
    needs: test
    with:
      name: integration
      command: npm test -- --suite integration

  release:
    needs: [test, reusable-unit, reusable-integration]
    if: github.ref == 'refs/heads/main'
    permissions:
      contents: write
      id-token: write
    steps:
      - inject: setup
      - run: npm publish --tag {{ params.channel }}
        fallback:
          - run: ./scripts/notify-publish-failed.sh

finally:
  on-failure:
    cleanup:
      runs-on: ubuntu-latest
      steps:
        - run: ./scripts/cleanup.sh
`;

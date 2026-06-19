# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-18

### Added

- Initial public release of `actio-core` and `actio-cli`.
- Transpiler engine (`actio-core`): parse, transform passes, emit, schema
  validation, and diagnostics for `.actio.yml` (a GitHub Actions YAML superset).
- Macro keywords: `fragments` + `inject`, `retry`, `dynamic-matrix`, and
  `fallback`, expanding into standard GitHub Actions workflow YAML.
- Command-line tool (`actio-cli`): `init`, `build`, `check`, and `watch`.
- Vendored GitHub Actions workflow JSON schema with Actio macro extensions,
  exported from `actio-core`.
- Custom-pass API and TypeScript config (`actio.config.ts`) support.

[Unreleased]: https://github.com/austenstone/actio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/austenstone/actio/releases/tag/v0.1.0

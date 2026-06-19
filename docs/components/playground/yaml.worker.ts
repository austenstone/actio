// esbuild entry point for the prebuilt YAML worker (scripts/build-monaco-workers.mjs
// bundles this into public/monaco/yaml.worker.js). monaco-yaml's worker carries the
// language host (validation, completion, hover) that drives schema-aware editing.
import 'monaco-yaml/yaml.worker';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Prebuild Monaco's web workers as standalone IIFE bundles served from
// `public/monaco/`. Turbopack splits `new Worker(new URL(...))` into async
// dependency chunks whose eval order is nondeterministic, which lets
// editor.worker's empty-host `self.onmessage` win the race over monaco-yaml's
// language host (symptom: "Missing requestHandler: doComplete"). A single IIFE
// fixes the internal init order and behaves identically in dev and the static
// export, decoupled from the app bundler.

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, '..');

await build({
  entryPoints: {
    'yaml.worker': join(docsRoot, 'components/playground/yaml.worker.ts'),
    'editor.worker': join(docsRoot, 'components/playground/editor.worker.ts'),
  },
  outdir: join(docsRoot, 'public/monaco'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

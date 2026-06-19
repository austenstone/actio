'use client';

import MonacoEditor, { loader } from '@monaco-editor/react';
// biome-ignore lint/style/useImportType: JSON value imported at runtime, not a type.
import actioSchema from 'actio-core/schema/actio.schema.json';
import * as monaco from 'monaco-editor';
import { configureMonacoYaml } from 'monaco-yaml';
import { useEffect, useMemo, useState } from 'react';

// Model paths. monaco-yaml scopes schemas via `fileMatch` against the model URI,
// so the editable source matches the schema while the generated output stays plain.
const SOURCE_PATH = 'source.actio.yml';
const OUTPUT_PATH = 'output.workflow.yml';

// Use the locally bundled Monaco (not the CDN AMD loader) so monaco-yaml's worker
// matches the editor's version, and wire workers the bundler-agnostic way. This
// module only ever loads in the browser (the playground mounts via dynamic ssr:false).
if (typeof window !== 'undefined') {
  window.MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === 'yaml') {
        return new Worker(new URL('monaco-yaml/yaml.worker', import.meta.url));
      }
      return new Worker(
        new URL('monaco-editor/esm/vs/editor/editor.worker', import.meta.url),
      );
    },
  };
  loader.config({ monaco });
  configureMonacoYaml(monaco, {
    enableSchemaRequest: false,
    schemas: [
      {
        uri: 'https://austenstone.github.io/actio/schema/actio.schema.json',
        fileMatch: [SOURCE_PATH],
        schema: actioSchema as object,
      },
    ],
  });
}

/** Track the site's dark/light mode via the `dark` class fumadocs toggles on <html>. */
function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains('dark'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

interface EditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  ariaLabel: string;
}

export function Editor({ value, onChange, readOnly, ariaLabel }: EditorProps) {
  const isDark = useIsDark();
  const options = useMemo<monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      readOnly,
      domReadOnly: readOnly,
      ariaLabel,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: 'on',
      wordWrap: 'on',
      tabSize: 2,
      folding: false,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 8, bottom: 8 },
      renderLineHighlight: readOnly ? 'none' : 'line',
      scrollbar: { alwaysConsumeMouseWheel: false },
      // Surface completions as you type, including inside string values.
      quickSuggestions: { other: true, comments: false, strings: true },
      suggestOnTriggerCharacters: true,
    }),
    [readOnly, ariaLabel],
  );

  return (
    <MonacoEditor
      language="yaml"
      path={readOnly ? OUTPUT_PATH : SOURCE_PATH}
      value={value}
      onChange={(next) => onChange?.(next ?? '')}
      theme={isDark ? 'vs-dark' : 'vs'}
      options={options}
      loading={
        <div className="px-4 py-3 text-sm text-fd-muted-foreground">Loading editor…</div>
      }
    />
  );
}

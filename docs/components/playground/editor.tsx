'use client';

import { yaml } from '@codemirror/lang-yaml';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';
import { yamlSchema } from '@valtown/codemirror-json-schema/yaml';
// biome-ignore lint/style/useImportType: JSON value imported at runtime, not a type.
import actioSchema from 'actio-core/schema/actio.schema.json';
import { useEffect, useMemo, useState } from 'react';

/** Read-only panes (generated output) get highlighting only. */
const plainExtensions: Extension[] = [yaml(), EditorView.lineWrapping];

/** Editable source pane gets schema-driven completion, hover, and linting. */
const schemaExtensions: Extension[] = [
  ...yamlSchema(actioSchema as Parameters<typeof yamlSchema>[0]),
  EditorView.lineWrapping,
];

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
  const extensions = useMemo(
    () => (readOnly ? plainExtensions : schemaExtensions),
    [readOnly],
  );
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      theme={isDark ? 'dark' : 'light'}
      extensions={extensions}
      height="100%"
      style={{ height: '100%', fontSize: 13 }}
      aria-label={ariaLabel}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
      }}
    />
  );
}

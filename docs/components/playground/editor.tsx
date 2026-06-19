'use client';

import { yaml } from '@codemirror/lang-yaml';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';
import { useEffect, useState } from 'react';

const yamlExtension: Extension[] = [yaml(), EditorView.lineWrapping];

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
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      theme={isDark ? 'dark' : 'light'}
      extensions={yamlExtension}
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

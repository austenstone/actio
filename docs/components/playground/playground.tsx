'use client';

import { transpile, type TranspileResult } from 'actio-core/browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Diagnostics } from './diagnostics';
import { Editor } from './editor';
import { sampleSource } from './sample';
import { readSourceFromHash, writeSourceToHash } from './share';

const DEBOUNCE_MS = 250;

const emptyResult: TranspileResult = { ok: true, yaml: '', diagnostics: [] };

export default function Playground() {
  const [source, setSource] = useState<string>(() => readSourceFromHash() ?? sampleSource);
  const [result, setResult] = useState<TranspileResult>(emptyResult);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback((value: string) => {
    try {
      setResult(transpile(value, { sourceMap: true }));
    } catch (error) {
      setResult({
        ok: false,
        yaml: '',
        diagnostics: [
          {
            severity: 'error',
            source: 'actio',
            message: `Transpiler crashed: ${(error as Error).message}`,
          },
        ],
      });
    }
  }, []);

  // Compile once on mount for the initial source.
  useEffect(() => {
    run(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChange = useCallback(
    (value: string) => {
      setSource(value);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        run(value);
        writeSourceToHash(value);
      }, DEBOUNCE_MS);
    },
    [run],
  );

  const { errors, warnings } = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const d of result.diagnostics) {
      if (d.severity === 'error') errors++;
      else if (d.severity === 'warning') warnings++;
    }
    return { errors, warnings };
  }, [result.diagnostics]);

  const share = useCallback(async () => {
    writeSourceToHash(source);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; the hash is still updated for manual copy.
    }
  }, [source]);

  const reset = useCallback(() => {
    setSource(sampleSource);
    run(sampleSource);
    writeSourceToHash(sampleSource);
  }, [run]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <div className="flex items-center gap-3 text-sm text-fd-muted-foreground">
          <span className={errors ? 'text-red-600 dark:text-red-400' : ''}>
            {errors} {errors === 1 ? 'error' : 'errors'}
          </span>
          <span className={warnings ? 'text-amber-600 dark:text-amber-400' : ''}>
            {warnings} {warnings === 1 ? 'warning' : 'warnings'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-fd-muted"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={share}
            className="rounded-md bg-fd-primary px-3 py-1.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            {copied ? 'Copied link' : 'Share'}
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1">
        <section className="flex min-h-0 flex-col border-b md:border-b-0 md:border-r">
          <header className="border-b px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-fd-muted-foreground">
            .actio.yml
          </header>
          <div className="min-h-0 flex-1 overflow-auto">
            <Editor value={source} onChange={onChange} ariaLabel="Actio source editor" />
          </div>
        </section>

        <section className="flex min-h-0 flex-col">
          <header className="border-b px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-fd-muted-foreground">
            GitHub Actions workflow
          </header>
          <div className="min-h-0 flex-1 overflow-auto">
            {result.yaml ? (
              <Editor value={result.yaml} readOnly ariaLabel="Generated workflow YAML" />
            ) : (
              <p className="px-4 py-3 text-sm text-fd-muted-foreground">
                No output — fix the errors below to generate a workflow.
              </p>
            )}
          </div>
          <div className="max-h-48 shrink-0 overflow-auto border-t">
            <Diagnostics diagnostics={result.diagnostics} />
          </div>
        </section>
      </div>
    </div>
  );
}

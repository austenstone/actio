import type { Diagnostic } from 'actio-core/browser';

const severityStyles: Record<Diagnostic['severity'], string> = {
  error: 'border-l-red-500 text-red-600 dark:text-red-400',
  warning: 'border-l-amber-500 text-amber-600 dark:text-amber-400',
  info: 'border-l-blue-500 text-blue-600 dark:text-blue-400',
};

function location(d: Diagnostic): string {
  if (!d.range) return '';
  return `${d.range.start.line}:${d.range.start.col}`;
}

export function Diagnostics({ diagnostics }: { diagnostics: Diagnostic[] }) {
  if (diagnostics.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-fd-muted-foreground">
        No diagnostics — your workflow compiled cleanly.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-fd-border">
      {diagnostics.map((d, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics have no stable id
          key={i}
          className={`border-l-2 px-3 py-2 text-sm ${severityStyles[d.severity]}`}
        >
          <div className="flex items-baseline gap-2">
            <span className="font-medium uppercase">{d.severity}</span>
            {location(d) && (
              <span className="font-mono text-xs text-fd-muted-foreground">{location(d)}</span>
            )}
            {d.code && (
              <span className="font-mono text-xs text-fd-muted-foreground">[{d.code}]</span>
            )}
          </div>
          <p className="text-fd-foreground">{d.message}</p>
          {d.hint && <p className="mt-0.5 text-xs text-fd-muted-foreground">hint: {d.hint}</p>}
        </li>
      ))}
    </ul>
  );
}

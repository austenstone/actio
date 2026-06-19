'use client';

import dynamic from 'next/dynamic';

// CodeMirror touches the DOM, so keep the whole playground client-only.
const Playground = dynamic(() => import('@/components/playground/playground'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-fd-muted-foreground">
      Loading playground…
    </div>
  ),
});

export function PlaygroundClient() {
  return <Playground />;
}

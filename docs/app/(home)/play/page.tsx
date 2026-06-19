import type { Metadata } from 'next';
import { PlaygroundClient } from './playground-client';

export const metadata: Metadata = {
  title: 'Playground',
  description:
    'Edit Actio source and see the generated GitHub Actions workflow YAML live, right in your browser.',
};

export default function PlaygroundPage() {
  return (
    <main className="h-[calc(100svh-3.5rem)]">
      <PlaygroundClient />
    </main>
  );
}

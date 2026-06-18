import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col justify-center px-4 py-16 text-center">
      <h1 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl">Actio</h1>
      <p className="mx-auto mb-8 max-w-2xl text-fd-muted-foreground sm:text-lg">
        A tiny YAML superset that compiles to standard GitHub Actions workflows. Author with macros,
        ship plain workflows. No runtime, no lock-in.
      </p>
      <div className="flex flex-row flex-wrap justify-center gap-3">
        <Link
          href="/docs"
          className="rounded-full bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
        >
          Get started
        </Link>
        <Link
          href="/docs/macros/fragments"
          className="rounded-full border px-5 py-2.5 font-medium transition-colors hover:bg-fd-muted"
        >
          Explore macros
        </Link>
      </div>
    </main>
  );
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const revalidate = false;

// Single source of truth lives at the repo root so coding agents and GitHub
// render the same file the deployed docs site serves at /AGENTS.md.
export function GET() {
  const body = readFileSync(join(process.cwd(), '..', 'AGENTS.md'), 'utf8');

  return new Response(body, {
    headers: { 'Content-Type': 'text/markdown;charset=UTF-8' },
  });
}

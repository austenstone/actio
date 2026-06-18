# Actio docs site

The [Actio](https://github.com/austenstone/actio) documentation site, built with
[Fumadocs](https://www.fumadocs.dev/) (Next.js App Router + Fumadocs MDX) and
deployed to GitHub Pages as a static export.

**Live site:** https://austenstone.github.io/actio

This app is intentionally isolated from the monorepo workspaces — it has its own
`package.json` and lockfile, so the heavy Next/React toolchain never touches the
core packages.

## Develop

```bash
cd docs
npm install
npm run dev
```

Open http://localhost:3000.

## Content

Pages live in `content/docs/` as MDX, with `meta.json` files controlling sidebar
order. Edit those to change the docs.

## Build

```bash
npm run build
```

Outputs a static site to `docs/out/`. In CI the build runs with
`PAGES_BASE_PATH=/actio` so assets resolve under the project Pages path; locally
it serves from the root.

## Deploy

Deployment is dogfooded through Actio itself: the workflow source is
`.github/actio/docs.actio.yml`, compiled to `.github/workflows/docs.yml`. Pushes
to `main` that touch `docs/**` rebuild and publish the site.

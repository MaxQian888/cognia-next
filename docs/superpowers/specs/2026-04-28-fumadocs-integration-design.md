---
title: Fumadocs Integration Design
date: 2026-04-28
status: approved
---

# Fumadocs Integration Design

## Overview

Integrate the [Fumadocs](https://fumadocs.dev) documentation framework into the `react-quick-starter` monorepo as a pnpm workspace subpackage (`docs/`). The docs site will be developed within the same repository but deployed independently from the main Next.js + Tauri application. Initial content is a minimal skeleton (one placeholder MDX page).

## Constraints

- The main app uses `output: "export"` in `next.config.ts` (required for Tauri static builds). The docs site must be completely isolated from this constraint.
- Package manager is pnpm. The root `pnpm-lock.yaml` must remain the single source of truth for all dependencies.
- Tooling (Prettier, ESLint, TypeScript) must be shared from the root without duplication.

## Repository Structure

```
react-quick-starter/
├── pnpm-workspace.yaml        # declares docs as workspace package
├── package.json               # adds docs:dev, docs:build, docs:start scripts
├── tsconfig.json              # existing (inherited by docs/tsconfig.json)
├── app/                       # main app — unchanged
├── components/                # main app — unchanged
└── docs/                      # new workspace subpackage
    ├── package.json           # "name": "docs", fumadocs deps
    ├── next.config.ts         # Fumadocs MDX plugin, no output:export
    ├── source.config.ts       # Fumadocs content source config
    ├── tsconfig.json          # extends ../tsconfig.json
    ├── app/
    │   ├── layout.tsx         # root layout with RootProvider
    │   ├── page.tsx           # redirect to /docs
    │   └── docs/
    │       ├── layout.tsx     # DocsLayout (sidebar + top nav)
    │       └── [[...slug]]/
    │           └── page.tsx   # dynamic doc page with generateStaticParams
    └── content/
        └── docs/
            ├── meta.json      # sidebar order and grouping
            └── index.mdx      # single placeholder doc
```

## Root-level Changes

### `pnpm-workspace.yaml` (new file)

```yaml
packages:
  - docs
```

### `package.json` additions

```json
"docs:dev":   "pnpm -F docs dev",
"docs:build": "pnpm -F docs build",
"docs:start": "pnpm -F docs start"
```

## `docs/` Package

### Dependencies (`docs/package.json`)

```json
{
  "name": "docs",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3001",
    "build": "next build",
    "start": "next start -p 3001"
  },
  "dependencies": {
    "fumadocs-ui": "latest",
    "fumadocs-core": "latest",
    "fumadocs-mdx": "latest",
    "next": "same version as root",
    "react": "same version as root",
    "react-dom": "same version as root"
  },
  "devDependencies": {
    "typescript": "same version as root",
    "@types/node": "same version as root",
    "@types/react": "same version as root",
    "@types/react-dom": "same version as root"
  }
}
```

Dev server runs on port **3001** to avoid conflict with the main app on port 3000.

### `docs/next.config.ts`

Uses `createMDX` from `fumadocs-mdx`. No `output: "export"` — full server mode for Fumadocs features (search API routes, etc.).

### `docs/source.config.ts`

Declares the docs collection pointing to `content/docs/` with MDX loader.

### `docs/tsconfig.json`

Extends `../tsconfig.json` with paths adjusted for the docs package root.

## App Router Layout

### `app/layout.tsx`

Mounts `RootProvider` from `fumadocs-ui/provider` — handles theme (dark/light via class toggle) and search context.

### `app/docs/layout.tsx`

Mounts `DocsLayout` from `fumadocs-ui/layouts/docs` with sidebar sourced from the MDX content tree.

### `app/docs/[[...slug]]/page.tsx`

- Exports `generateStaticParams` (returns all MDX file slugs)
- Exports `generateMetadata` (returns title/description from frontmatter)
- Renders `DocsPage` from `fumadocs-ui/page`

## Search

Uses Fumadocs built-in **Orama static search** (`createFromSource` in `app/api/search/route.ts`). Orama indexes content at build time and runs entirely client-side — no external search service required, no server dependency at runtime.

## Content Skeleton

```
content/docs/
├── meta.json      # { "pages": ["index"] }
└── index.mdx      # frontmatter: title, description; body: placeholder text
```

Single `index.mdx` with a welcome/placeholder message. Sidebar shows one entry.

## Tooling Sharing

| Tool          | Mechanism                                                               |
| ------------- | ----------------------------------------------------------------------- |
| TypeScript    | `docs/tsconfig.json` extends `../tsconfig.json`                         |
| Prettier      | Root `.prettierrc` auto-discovered (no extra config needed)             |
| ESLint        | Root `eslint.config.mjs` auto-discovered                                |
| pnpm lockfile | Single `pnpm-lock.yaml` at root; `pnpm install` installs all workspaces |

## Build & Deployment

| Target   | Command           | Output                 | Deployment                   |
| -------- | ----------------- | ---------------------- | ---------------------------- |
| Main app | `pnpm build`      | `out/` (static)        | Tauri / CDN                  |
| Docs     | `pnpm docs:build` | `docs/.next/` (server) | Vercel / Netlify / Node host |

The two build targets are fully independent and do not interfere.

## Out of Scope

- Sharing design tokens or shadcn/ui components between main app and docs (can be added later if needed)
- i18n for docs (Fumadocs has i18n support but not needed for skeleton)
- Algolia or other external search providers
- Tauri-bundled docs (docs are web-only)

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

React + Tauri desktop application starter: Next.js 16 (React 19) + Tauri 2.9 + TypeScript + Tailwind CSS v4 + shadcn/ui + Zustand.

**Dual Runtime Model:**

- **Web mode** (`pnpm dev`): Next.js dev server at <http://localhost:3000>
- **Desktop mode** (`pnpm tauri dev`): Tauri wraps Next.js in a native window

## Development Commands

```bash
# Frontend (main app — port 3000)
pnpm dev              # Start Next.js dev server
pnpm build            # Build for production (outputs to out/)
pnpm lint             # Run ESLint
pnpm lint:fix         # Auto-fix ESLint issues
pnpm format           # Format with Prettier
pnpm format:check     # Check formatting without writing
pnpm typecheck        # TypeScript --noEmit

# Testing
pnpm test             # Run Jest tests
pnpm test:watch       # Run tests in watch mode
pnpm test:coverage    # Run tests with coverage report

# Desktop (Tauri)
pnpm tauri dev        # Dev mode with hot reload
pnpm tauri build      # Build desktop installer
pnpm tauri info       # Check Tauri environment

# Docs site (pnpm workspace — port 3001)
pnpm docs:dev         # Start Fumadocs dev server
pnpm docs:build       # Build docs for production
pnpm docs:start       # Start docs production server

# Add shadcn/ui components
pnpm dlx shadcn@latest add <component-name>
```

## Architecture

### Workspace Structure

This is a **pnpm monorepo** with two packages:

| Package  | Path       | Port | Purpose                                          |
| -------- | ---------- | ---- | ------------------------------------------------ |
| Main app | `/` (root) | 3000 | Next.js + Tauri desktop app (`output: "export"`) |
| Docs     | `docs/`    | 3001 | Fumadocs documentation site (full server mode)   |

Root `pnpm-lock.yaml` is the single lockfile for all packages. Run `pnpm install` from the repo root.

### Frontend Structure (main app)

- `app/` - Next.js App Router (layout.tsx, page.tsx, globals.css)
- `components/ui/` - All 57 shadcn/ui components pre-installed (**no test files here**)
- `hooks/` - Shared hooks (e.g., `use-mobile.ts`)
- `lib/utils.ts` - `cn()` utility (clsx + tailwind-merge)

### Docs Structure (`docs/`)

- `docs/app/` - Next.js App Router for the docs site
  - `docs/app/layout.tsx` - Root layout with `RootProvider` (from `fumadocs-ui/provider/next`)
  - `docs/app/docs/layout.tsx` - `DocsLayout` with sidebar
  - `docs/app/docs/[[...slug]]/page.tsx` - Dynamic MDX page
  - `docs/app/api/search/route.ts` - Orama full-text search
- `docs/lib/source.ts` - Fumadocs loader (imports from `collections/server`)
- `docs/source.config.ts` - Content collection definition
- `docs/content/docs/` - MDX content files and `meta.json` sidebar config
- `docs/.source/` - **Auto-generated** by fumadocs-mdx at dev/build time (gitignored)

**Docs-specific import conventions:**

- Source loader: `import { source } from "@/lib/source"` (NOT `@/app/source`)
- Collection output: `import { docs } from "collections/server"` (tsconfig alias → `.source/`)
- Provider: `fumadocs-ui/provider/next` (NOT `fumadocs-ui/provider`)

### Installed shadcn/ui Components

All components are pre-installed — import directly, do not run `shadcn add` for these:

`accordion` · `alert` · `alert-dialog` · `aspect-ratio` · `avatar` · `badge` · `breadcrumb` · `button` · `button-group` · `calendar` · `card` · `carousel` · `chart` · `checkbox` · `collapsible` · `combobox` · `command` · `context-menu` · `dialog` · `direction` · `drawer` · `dropdown-menu` · `empty` · `field` · `form` · `hover-card` · `input` · `input-group` · `input-otp` · `item` · `kbd` · `label` · `menubar` · `native-select` · `navigation-menu` · `pagination` · `popover` · `progress` · `radio-group` · `resizable` · `scroll-area` · `select` · `separator` · `sheet` · `sidebar` · `skeleton` · `slider` · `sonner` · `spinner` · `switch` · `table` · `tabs` · `textarea` · `toggle` · `toggle-group` · `tooltip`

`TooltipProvider` is already mounted in `app/layout.tsx` — no extra wrapper needed.

### Tauri Integration

- `src-tauri/` - Rust backend
  - `tauri.conf.json` - Config pointing `frontendDist` to `../out`
  - `beforeDevCommand`: runs `pnpm dev`
  - `beforeBuildCommand`: runs `pnpm build`

### Styling System

- **Tailwind v4** via PostCSS (`@tailwindcss/postcss`)
- CSS variables for theme colors (oklch color space) in `globals.css`
- Dark mode: class-based (apply `.dark` to parent element)
- Custom variant: `@custom-variant dark (&:is(.dark *))`

### Path Aliases

`@/components`, `@/lib`, `@/utils`, `@/ui`, `@/hooks` - all configured in tsconfig.json and components.json

## Code Patterns

```tsx
// Always use cn() for conditional classes
import { cn } from "@/lib/utils"
cn("base-classes", condition && "conditional", className)

// Button composition with asChild
<Button asChild>
  <Link href="/path">Click me</Link>
</Button>
```

```tsx
// Calling Rust from the frontend (Tauri only) — see lib/tauri.ts
import { greet, isTauri } from "@/lib/tauri"
if (isTauri()) {
  greet("World").then((msg) => console.log(msg))
}
```

## Data Backup & Transfer

cognia-next ships a full-featured backup/import system under `lib/data/`. The
schema is **v3** (`BackupPackageV3` in `lib/data/types.ts`). v1 files import
through the `migrateEnvelope` boundary so legacy users keep working.

- **Build a snapshot**: `buildBackupPackage({ includeSessions, includeApiKey })`
  → returns `BackupPackageV3` with a `manifest.integrity` SHA-256 checksum.
- **Encrypt**: `encryptBackupPackage(plaintext, passphrase, manifest)` →
  `EncryptedEnvelopeV1` (AES-GCM, PBKDF2-SHA256-600000).
- **Migrate-on-import**: `migrateEnvelope(parsed)` accepts v1, v3, or
  encrypted; throws `IsEncryptedError` for the latter so the caller can
  prompt for a passphrase.
- **Apply**: `applyBackupPackage(pkg, opts)` writes the payload to Dexie
  under one of three merge strategies (skip / overwrite / duplicate),
  preserving built-in characters/skills/teams.
- **Per-domain transfers**: `lib/data/domain/index.ts` exports `DOMAIN_TRANSFERS`
  - `buildDomainExport(key)` / `applyDomainImport(file, strategy)` for each of
    skills, MCP servers, prompt presets, characters, teams, and theme.
- **External imports**: `lib/data/import-registry.ts` dispatches to
  `chatgpt-import.ts` / `claude-import.ts` / `gemini-import.ts`.
- **Scheduled backups**: `BackupSchedulerProvider` mounted in `app/layout.tsx`
  drives an auto-key encrypted write every `intervalDays` to the user's
  configured folder (Tauri only). Web users see the reminder banner.
- **History**: `lib/db/backup-history.ts` records every success/failure to
  the `backupHistory` Dexie table (capped at 50 newest, indexed by completedAt).
- **Settings tabs**: `components/settings/data/data-section.tsx` is a tabbed
  shell — Overview / Backup & restore / Domain transfer / Maintenance, with
  the active tab reflected in `?dataTab=` on the URL.
- **Chat-header trigger**: every chat shows a `SingleExportTrigger`
  (`components/chat/dialogs/single-export-trigger.tsx`) that opens a
  per-session export dialog (Markdown / JSON / Plain text / Beautiful HTML
  / Animated HTML, with theme + custom-theme editor for the HTML formats).

See `docs/content/docs/adr/0001-backup-schema-v3.md` for the full ADR.

## Testing Standards

- **Coverage requirement**: every source file must reach **≥90% test coverage** (lines, branches, functions). Verify with `pnpm test:coverage`.
- **TypeScript / TSX tests**: co-locate next to the source file as `xxx.test.ts` or `xxx.test.tsx` (e.g., `lib/avatar.ts` → `lib/avatar.test.ts`, `components/chat/message.tsx` → `components/chat/message.test.tsx`). Do **not** use a separate `__tests__/` or `tests/` directory.
- **Rust tests**: write inside the same `.rs` file in a `#[cfg(test)] mod tests { ... }` block. Do not create separate test files for unit tests (integration tests in `src-tauri/tests/` are still allowed).
- **Exceptions** (no tests, exclude from coverage thresholds):
  - `components/ui/` — vendored shadcn/ui
  - `components/ai-elements/` — vendored ai-elements components

## Critical Notes

- **Always use pnpm** (lockfile present); run `pnpm install` from repo root to install all workspaces
- **Tauri production builds require static export**: `next.config.ts` (main app) has `output: "export"` — do not remove it
- **Docs does NOT use static export**: `docs/next.config.ts` is full server mode — keep them separate
- **Rust toolchain**: Requires v1.77.2+ for Tauri builds
- **Docs `.source/` is generated**: run `pnpm docs:dev` or `pnpm docs:build` once before TypeScript resolves `collections/server`
- shadcn/ui configured with "new-york" style and RSC mode

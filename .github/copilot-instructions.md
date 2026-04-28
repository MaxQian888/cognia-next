# Copilot Instructions for react-quick-starter

## Project Architecture

This is a **Next.js 16 (App Router) + Tauri v2 hybrid desktop application** combining:

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui components
- **Desktop wrapper**: Tauri v2.9 (Rust-based) for native desktop capabilities
- **State management**: Zustand (configured but not actively used in starter)

### Dual Runtime Model

1. **Web mode** (`pnpm dev`): Next.js dev server at http://localhost:3000
2. **Desktop mode** (`pnpm tauri dev`): Tauri wraps the Next.js app in a native window

⚠️ **Critical**: When Tauri builds for production, it expects static export from Next.js (`out/` directory). The `tauri.conf.json` points `frontendDist` to `../out`, but Next.js currently uses default (server-side) mode. To enable Tauri production builds, you must add `output: "export"` to `next.config.ts`.

## Key File Locations & Conventions

### Routing & Layouts

- `app/layout.tsx`: Root layout, configures Geist fonts via `next/font/google`, imports `globals.css`
- `app/page.tsx`: Home route demonstrating Tailwind + `next/image` usage
- Path alias: `@/*` maps to repo root (e.g., `@/lib/utils`)

### Styling System

- **Tailwind v4** via PostCSS plugin (`@tailwindcss/postcss`)
- `app/globals.css`:
  - Imports `tailwindcss` and `tw-animate-css`
  - Defines CSS variables for theme colors (oklch color space)
  - Uses `@theme inline` to map CSS vars to Tailwind utilities
  - Custom dark mode variant: `@custom-variant dark (&:is(.dark *))`
- Color system: All colors defined as CSS variables (light + `.dark` overrides)

### Component Patterns

- **shadcn/ui components** in `components/ui/`
- Example: `components/ui/button.tsx` uses:
  - `@radix-ui/react-slot` for `asChild` polymorphism
  - `class-variance-authority` for variant management
  - `cn()` utility from `@/lib/utils` (clsx + tailwind-merge)
- Config: `components.json` defines shadcn settings (New York style, RSC mode)

### Tauri Integration

- `src-tauri/src/lib.rs`: Main Tauri setup (enables debug logging in dev)
- `src-tauri/tauri.conf.json`:
  - `devUrl`: Points to Next.js dev server
  - `frontendDist`: Expects `../out` (static export)
  - `beforeDevCommand`: Runs `pnpm dev`
  - `beforeBuildCommand`: Runs `pnpm build`

## Developer Workflows

### Package Management

**Always use pnpm** (lockfile present). Commands:

- `pnpm install` - Install dependencies
- `pnpm dev` - Next.js dev server (web-only)
- `pnpm tauri dev` - Desktop app with hot reload
- `pnpm build` - Next.js production build
- `pnpm tauri build` - Create desktop installer (requires static export)

### Code Quality

- **Type checking**: `pnpm exec tsc --noEmit` (strict mode enabled)
- **Linting**: `pnpm run lint` (ESLint flat config with `eslint-config-next`)
  - Auto-fix: `pnpm exec eslint . --fix`
  - Single file: `pnpm exec eslint <file>`
- **No test framework configured** (no test scripts present)

### Adding shadcn/ui Components

Use the shadcn CLI: `pnpm dlx shadcn@latest add <component-name>`

- Components install to `components/ui/`
- Automatically uses configured aliases and style

## Project-Specific Patterns

### Import Paths

Always use `@/` alias for internal imports:

```typescript
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
```

### Component Composition

Prefer composition patterns with `asChild` for buttons/links:

```tsx
<Button asChild>
  <Link href="/path">Click me</Link>
</Button>
```

### Dark Mode

- Class-based dark mode (not media query)
- Apply `.dark` class to parent element
- All color utilities automatically support dark variants via custom variant

### Styling Utilities

- Use `cn()` from `@/lib/utils` to merge Tailwind classes safely
- Example: `cn("base-classes", conditionalClass && "conditional-classes", className)`

## Known Configuration Notes

- **ESLint**: Flat config format with Next.js core-web-vitals + TypeScript rules
- **TypeScript**: Strict mode, bundler module resolution, JSX set to `react-jsx`
- **Next.js config**: Currently minimal (no custom webpack/rewrites)
- **Rust toolchain**: Requires v1.77.2+ for Tauri builds
- **WARP.md exists**: Contains terminal-focused guidance (complementary to this file)

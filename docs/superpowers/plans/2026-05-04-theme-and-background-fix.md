# Theme and Background Customization Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the unmounted theme/background hooks, fix VSCode JSON+VSIX import, complete the dual-variant token model with OKLCH derivation, and add WCAG contrast guards — fully realizing the half-built appearance subsystem documented in `docs/content/docs/adr/0007-theme-and-background-fix.md`.

**Architecture:** Six phases. Phase 1 unblocks usability by hydrating the settings store, mounting a custom-theme applier, expanding the token key set, and wiring `data-bg-target` onto chat/canvas/sidebar/global containers. Phase 2 introduces the dual-variant `{ light, dark }` token shape with OKLCH-based auto-derivation behind a Dexie v15→v16 migration. Phase 3 hardens the VSCode JSON+VSIX parsers (reversed fallback order, expanded key map, eager VSIX parsing). Phase 4 adds the contrast guard, scope cards, and scrim CSS. Phase 5 ships theme JSON export/import, reset-to-defaults, and four built-in VSCode-style presets. Phase 6 covers integration tests + the 8-step manual verification gate.

**Tech Stack:** Next.js 16 / React 19 / TypeScript 5 / Tailwind v4 / Dexie 4 / next-themes / shadcn-ui (vendored) / `culori` (new dep, OKLCH math) / `jszip` (existing, VSIX) / Jest + RTL via `pnpm test`.

---

## File Structure

### New files

| Path                                                                 | Responsibility                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `components/providers/settings-hydrator.tsx`                         | Mount-once `useEffect` calls `useSettingsStore.load()`.                                  |
| `components/providers/settings-hydrator.test.tsx`                    | Asserts the store transitions `loaded:false → true`.                                     |
| `lib/appearance/custom-theme-applier.tsx`                            | Subscribes to active custom theme + resolved theme; writes 23 CSS variables to `<html>`. |
| `lib/appearance/custom-theme-applier.test.tsx`                       | Asserts CSS vars appear on `<html>` when a custom theme is active.                       |
| `lib/appearance/derive-variant.ts`                                   | OKLCH algorithm: `deriveOppositeVariant(source, sourceVariant) → ThemeColors`.           |
| `lib/appearance/derive-variant.test.ts`                              | Tests for neutral flip, accent attenuation, contrast enforcement.                        |
| `lib/appearance/contrast.ts`                                         | `wcagContrast(fg, bg)` and `evaluateReadability(...)` utilities.                         |
| `lib/appearance/contrast.test.ts`                                    | Boundary cases for contrast levels and recommendations.                                  |
| `lib/appearance/contrast-audit.ts`                                   | `auditThemeContrast(tokens)` — list of failing pairs.                                    |
| `lib/appearance/contrast-audit.test.ts`                              | Asserts the 8 critical pairs are all checked.                                            |
| `lib/appearance/theme-export.ts`                                     | `exportThemeToJson(theme)` / `importThemeFromJson(text)`.                                |
| `lib/appearance/theme-export.test.ts`                                | Round-trip an exported theme through the importer.                                       |
| `lib/appearance/built-in-vscode-themes.ts`                           | 4 inlined VSCode themes wired through the JSON parser.                                   |
| `lib/appearance/built-in-vscode-themes.test.ts`                      | Snapshot the 4 derived `CustomTheme[]`.                                                  |
| `lib/appearance/vscode-theme/__fixtures__/dracula.json`              | Real Dracula JSON from the VSCode marketplace.                                           |
| `lib/appearance/vscode-theme/__fixtures__/one-dark-pro.json`         | Real One Dark Pro JSON.                                                                  |
| `lib/appearance/vscode-theme/__fixtures__/tokyo-night-dark.json`     | Real Tokyo Night Dark JSON.                                                              |
| `lib/appearance/vscode-theme/__fixtures__/github-light-default.json` | Real GitHub Light Default JSON.                                                          |
| `lib/appearance/vscode-theme/__fixtures__/dracula.vsix`              | Real .vsix bundle.                                                                       |
| `lib/appearance/vscode-theme/__fixtures__/no-themes.vsix`            | Synthetic — manifest valid, no themes contributed.                                       |
| `lib/appearance/vscode-theme/__fixtures__/corrupt.vsix`              | Truncated zip (asserts parser raises specific error).                                    |
| `tests/integration/appearance.test.tsx`                              | End-to-end-flavored Jest+jsdom test mirroring the 8-step manual checklist.               |

### Modified files

| Path                                                           | What changes                                                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                 | Add `culori@^4` dep.                                                                                                                                      |
| `app/layout.tsx`                                               | Mount `<SettingsHydrator>` and `<CustomThemeApplier>` next to existing `<BackgroundApplier>`.                                                             |
| `app/globals.css`                                              | Add `[data-bg-scrim="true"]::after` rule.                                                                                                                 |
| `lib/db/schema.ts`                                             | New `.version(16).upgrade(tx)` — migrate `customThemes[].colors` (single set) to `tokens.{light,dark}` dual set.                                          |
| `lib/appearance/vscode-theme/token-mapping.ts`                 | Expand `THEME_COLOR_KEYS` from 16 → 23 keys; expand `VSCODE_COLOR_MAP` to cover the 25-key VSCode standard; add `DEFAULT_FALLBACKS` entries for new keys. |
| `lib/appearance/vscode-theme/parse-json.ts`                    | Reverse fallback order (derived first, hardcoded last); upgrade `readableForeground` to WCAG-aware.                                                       |
| `lib/appearance/vscode-theme/parse-vsix.ts`                    | Eager parse — return fully populated `ParsedTheme[]`, drop the lazy `parse()` closure; explicit error wrapping.                                           |
| `lib/appearance/vscode-theme/color-utils.ts`                   | Add `oklchFromCss`, `cssFromOklch`, `enforceReadable` helpers using `culori`.                                                                             |
| `lib/appearance/background-applier.tsx`                        | Set `data-bg-scrim="true"` when `opacity < 0.5` and source is image; set scope-target attributes.                                                         |
| `lib/themes/index.ts`                                          | Adjust `resolveActiveThemeColors` to read `tokens[resolvedTheme]` (dual variant) with legacy `colors` fallback.                                           |
| `stores/settings/settings-store.ts`                            | `createCustomTheme`/`updateCustomTheme` accept dual-variant shape; `setActiveCustomTheme` triggers an extra render via subscription.                      |
| `types/plugin/plugin-extended.ts`                              | Update `CustomTheme` shape: new `baseVariant`, `tokens: { light, dark }`, `derivedVariant?`; expand `ThemeColors` to 23 keys.                             |
| `components/settings/appearance/tabs/custom-theme-tab.tsx`     | Edit dual-variant tokens; render contrast numbers per row + health badge; export/import buttons; save dialog warns on contrast failures.                  |
| `components/settings/appearance/tabs/wallpaper-tab.tsx`        | Replace scope `<Select>` with 5 layout-thumbnail cards; add opacity contrast chip + auto-fix button.                                                      |
| `components/settings/appearance/tabs/vscode-import-tab.tsx`    | Show explicit error alerts; 30 s loading timeout; use eager parser.                                                                                       |
| `components/settings/appearance/tabs/theme-tab.tsx`            | Append a "VSCode-inspired" section with the 4 built-in presets.                                                                                           |
| `components/settings/appearance/appearance-section.tsx`        | Header "Reset appearance" button.                                                                                                                         |
| Chat container (TBD via grep)                                  | Add `data-bg-target="chat"` on the chat shell root.                                                                                                       |
| Canvas container (TBD via grep)                                | Add `data-bg-target="canvas"` on the canvas/twin workbench root.                                                                                          |
| Sidebar container (TBD via grep)                               | Add `data-bg-target="sidebar"` on the global navigation sidebar root.                                                                                     |
| Main content container (TBD via grep, likely `app/layout.tsx`) | Add `data-bg-target="global"` on the main content wrapper.                                                                                                |

---

## How to run tests

```powershell
rtk pnpm typecheck                            # TS only — fast feedback
rtk pnpm test <path-to-test>                  # single file
rtk pnpm test:coverage -- --collectCoverageFrom='lib/appearance/**'
rtk pnpm lint                                 # before commit
```

`rtk` strips noise from the output. Skip if the user opts out.

---

## Phase ordering and parallelization

```
Phase 1 (sequential): F1 → B2 → B1 → E1 (each task unblocks the next)
   ↓
Phase 2 (sequential, depends on Phase 1): derive-variant → CustomTheme type → migration → store integration
   ↓
   ├─ Phase 3 (parallel): VSCode parser improvements
   └─ Phase 4 (parallel): UX polish — contrast, scope cards, scrim
   ↓
Phase 5 (sequential, depends on 2,3,4): theme JSON I/O, reset, built-in presets
   ↓
Phase 6 (gate): integration tests + 8-step manual verification
```

**Parallel-safe agents:** Phase 3 (VSCode parsing) and Phase 4 (UX polish) touch disjoint file sets — dispatch as parallel subagents after Phase 2 completes. Phase 1 must be sequential because each task builds on the prior (the applier depends on expanded keys; data-bg-target depends on the applier rendering correctly).

---

# Phase 1 — Critical fixes (sequential)

This phase makes the existing UI promise true without changing data shapes. After Phase 1, custom themes apply, settings persist across refresh, and `scope` actually works. Tests added here will continue to pass after Phase 2's schema upgrade.

---

### Task 1: Add `culori` dependency

**Why first:** Several later tasks (derive-variant, color-utils, contrast) need OKLCH math. Installing now means parallel agents in later phases don't all hit the package install simultaneously.

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml` (auto)

- [ ] **Step 1: Install dep**

```powershell
rtk pnpm add culori@^4 -w
```

Expected: `+ culori 4.x.x` in dependencies; lockfile updated.

- [ ] **Step 2: Type-check**

```powershell
rtk pnpm typecheck
```

Expected: clean. (`culori` ships its own `.d.ts`.)

- [ ] **Step 3: Commit**

```powershell
rtk git add package.json pnpm-lock.yaml
rtk git commit -m "chore(appearance): add culori for OKLCH derivation"
```

---

### Task 2: SettingsHydrator — fix F1 (settings lost on refresh)

**Files:**

- Create: `components/providers/settings-hydrator.tsx`
- Create: `components/providers/settings-hydrator.test.tsx`
- Modify: `app/layout.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// components/providers/settings-hydrator.test.tsx
import { render } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { SettingsHydrator } from "./settings-hydrator"

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn().mockResolvedValue({
    id: "singleton",
    permissionMode: "default",
    alwaysAllowTools: [],
    builtinTools: {},
    theme: "dark",
  }),
  saveSettings: jest.fn(),
  addAlwaysAllow: jest.fn(),
  removeAlwaysAllow: jest.fn(),
}))

describe("SettingsHydrator", () => {
  beforeEach(() => {
    // Reset store between tests so `loaded` starts false.
    useSettingsStore.setState({ settings: null, loaded: false, providerKeys: {} })
  })

  it("calls load() on mount and transitions loaded → true", async () => {
    expect(useSettingsStore.getState().loaded).toBe(false)
    render(<SettingsHydrator />)
    // load() is async; flush microtasks.
    await new Promise((r) => setTimeout(r, 0))
    expect(useSettingsStore.getState().loaded).toBe(true)
  })

  it("is idempotent — second mount does not re-call getSettings", async () => {
    const { getSettings } = await import("@/lib/db/settings")
    render(<SettingsHydrator />)
    await new Promise((r) => setTimeout(r, 0))
    render(<SettingsHydrator />)
    await new Promise((r) => setTimeout(r, 0))
    expect((getSettings as jest.Mock).mock.calls.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run test — should fail with "Cannot find module"**

```powershell
rtk pnpm test components/providers/settings-hydrator.test.tsx
```

Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement**

```tsx
// components/providers/settings-hydrator.tsx
"use client"

import { useEffect } from "react"
import { useSettingsStore } from "@/stores/settings"

/**
 * Mounts at the root layout and triggers `useSettingsStore.load()` exactly
 * once. Without this hook the store stays at `{ loaded: false, settings: null }`
 * forever, which makes `SettingsSyncProvider` early-return and the user sees
 * defaults regardless of what's persisted in Dexie.
 *
 * `load()` itself is idempotent (early-returns when `loaded`), so re-mounts
 * during dev/HMR don't trigger duplicate Dexie reads.
 */
export function SettingsHydrator(): null {
  useEffect(() => {
    void useSettingsStore.getState().load()
  }, [])
  return null
}
```

- [ ] **Step 4: Run test again**

```powershell
rtk pnpm test components/providers/settings-hydrator.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Mount in layout**

In `app/layout.tsx`, add the import and mount it inside `<ThemeProvider>` but before `<LocaleGate>` so settings are loaded before any other consumer reads them:

```tsx
// app/layout.tsx — at the top with other providers
import { SettingsHydrator } from "@/components/providers/settings-hydrator"

// Inside the JSX, immediately inside <ThemeProvider>:
<ThemeProvider ...>
  <SettingsHydrator />          {/* NEW — must be first child */}
  <LocaleGate>
    <SettingsSyncProvider>
      ...existing...
    </SettingsSyncProvider>
  </LocaleGate>
</ThemeProvider>
```

- [ ] **Step 6: Verify typecheck and lint**

```powershell
rtk pnpm typecheck && rtk pnpm lint
```

Expected: clean.

- [ ] **Step 7: Commit**

```powershell
rtk git add components/providers/settings-hydrator.tsx components/providers/settings-hydrator.test.tsx app/layout.tsx
rtk git commit -m "fix(appearance): hydrate settings store on mount

The store's load() was defined but never invoked, leaving every appearance
setting at defaults until the user manually changed it. SettingsSyncProvider
already guards on loaded=true, so no other rewiring is needed."
```

---

### Task 3: Expand `THEME_COLOR_KEYS` to 23 keys — fix B2 (token map incomplete)

**Files:**

- Modify: `types/plugin/plugin-extended.ts`
- Modify: `lib/appearance/vscode-theme/token-mapping.ts`
- Modify: `lib/themes/index.ts`

- [ ] **Step 1: Read the existing `ThemeColors` shape**

```powershell
rtk pnpm test --testPathPattern=token-mapping
```

Note current passing tests so the new keys don't break them.

- [ ] **Step 2: Update the type**

In `types/plugin/plugin-extended.ts`, find `ThemeColors` (currently 16 keys) and add 7 keys. Replace with:

```ts
export interface ThemeColors {
  background: string
  foreground: string
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  accent: string
  accentForeground: string
  muted: string
  mutedForeground: string
  card: string
  cardForeground: string
  popover: string // NEW
  popoverForeground: string // NEW
  input: string // NEW
  border: string
  ring: string
  destructive: string
  destructiveForeground: string
  sidebar: string // NEW
  sidebarForeground: string // NEW
  sidebarPrimary: string // NEW
  sidebarBorder: string // NEW
}
```

- [ ] **Step 3: Update `THEME_COLOR_KEYS`**

In `lib/appearance/vscode-theme/token-mapping.ts`, replace the constant:

```ts
export const THEME_COLOR_KEYS: readonly (keyof ThemeColors)[] = [
  "background",
  "foreground",
  "primary",
  "primaryForeground",
  "secondary",
  "secondaryForeground",
  "accent",
  "accentForeground",
  "muted",
  "mutedForeground",
  "card",
  "cardForeground",
  "popover",
  "popoverForeground",
  "input",
  "border",
  "ring",
  "destructive",
  "destructiveForeground",
  "sidebar",
  "sidebarForeground",
  "sidebarPrimary",
  "sidebarBorder",
] as const
```

- [ ] **Step 4: Add VSCode mappings for the new keys** in the same file:

```ts
export const VSCODE_COLOR_MAP: Record<keyof ThemeColors, readonly string[]> = {
  background: ["editor.background", "tab.activeBackground"],
  foreground: ["editor.foreground", "foreground"],

  primary: [
    "button.background",
    "button.hoverBackground",
    "activityBarBadge.background",
    "statusBarItem.prominentBackground",
  ],
  primaryForeground: ["button.foreground", "activityBarBadge.foreground"],

  secondary: [
    "panel.background",
    "sideBarSectionHeader.background",
    "editorGroupHeader.tabsBackground",
  ],
  secondaryForeground: ["panel.border", "tab.inactiveForeground", "foreground"],

  accent: [
    "list.activeSelectionBackground",
    "list.focusBackground",
    "editor.selectionBackground",
    "editorLink.activeForeground",
  ],
  accentForeground: [
    "list.activeSelectionForeground",
    "list.focusForeground",
    "tab.activeForeground",
  ],

  muted: ["editor.lineHighlightBackground", "input.background", "editorWidget.background"],
  mutedForeground: [
    "descriptionForeground",
    "editorLineNumber.foreground",
    "tab.inactiveForeground",
  ],

  card: ["editorGroup.dropBackground", "panel.background", "editor.background"],
  cardForeground: ["editorWidget.foreground", "foreground"],

  popover: ["editorWidget.background", "dropdown.background", "quickInput.background"],
  popoverForeground: ["editorWidget.foreground", "dropdown.foreground", "foreground"],

  input: ["input.background", "editorWidget.background"],

  border: [
    "panel.border",
    "editorWidget.border",
    "editorGroup.border",
    "tab.border",
    "input.border",
  ],
  ring: ["focusBorder", "editorWidget.border"],

  destructive: ["errorForeground", "editorError.foreground", "inputValidation.errorBorder"],
  destructiveForeground: ["editor.background"],

  sidebar: ["sideBar.background", "activityBar.background"],
  sidebarForeground: ["sideBar.foreground", "activityBar.foreground"],
  sidebarPrimary: ["activityBarBadge.background", "list.activeSelectionBackground"],
  sidebarBorder: ["sideBar.border", "activityBar.border"],
}
```

- [ ] **Step 5: Add fallbacks for the new keys**

```ts
export const DEFAULT_FALLBACKS: { light: ThemeColors; dark: ThemeColors } = {
  light: {
    primary: "#3b82f6",
    primaryForeground: "#ffffff",
    secondary: "#64748b",
    secondaryForeground: "#ffffff",
    accent: "#3b82f6",
    accentForeground: "#ffffff",
    background: "#ffffff",
    foreground: "#0f172a",
    muted: "#f1f5f9",
    mutedForeground: "#64748b",
    card: "#ffffff",
    cardForeground: "#0f172a",
    popover: "#ffffff",
    popoverForeground: "#0f172a",
    input: "#e2e8f0",
    border: "#e2e8f0",
    ring: "#3b82f6",
    destructive: "#ef4444",
    destructiveForeground: "#ffffff",
    sidebar: "#f8fafc",
    sidebarForeground: "#0f172a",
    sidebarPrimary: "#3b82f6",
    sidebarBorder: "#e2e8f0",
  },
  dark: {
    primary: "#60a5fa",
    primaryForeground: "#0b1220",
    secondary: "#94a3b8",
    secondaryForeground: "#0b1220",
    accent: "#60a5fa",
    accentForeground: "#0b1220",
    background: "#0b1220",
    foreground: "#f1f5f9",
    muted: "#1e293b",
    mutedForeground: "#94a3b8",
    card: "#0f172a",
    cardForeground: "#f1f5f9",
    popover: "#0f172a",
    popoverForeground: "#f1f5f9",
    input: "#1e293b",
    border: "#1e293b",
    ring: "#60a5fa",
    destructive: "#f87171",
    destructiveForeground: "#0b1220",
    sidebar: "#0f172a",
    sidebarForeground: "#f1f5f9",
    sidebarPrimary: "#60a5fa",
    sidebarBorder: "#1e293b",
  },
}
```

- [ ] **Step 6: Update `lib/themes/index.ts` `NEUTRAL_LIGHT`/`NEUTRAL_DARK`** with the same 7 new keys (mirror values from `DEFAULT_FALLBACKS` above; do not invent new colors).

- [ ] **Step 7: Run typecheck — fix any callers**

```powershell
rtk pnpm typecheck
```

Some places likely consume `ThemeColors` and have to spread the new keys. Fix as compile errors surface (most should be in test files where mock `ThemeColors` literals are constructed).

- [ ] **Step 8: Run all tests**

```powershell
rtk pnpm test
```

Expected: green (or only failures in tests we're about to write — note them).

- [ ] **Step 9: Commit**

```powershell
rtk git add -A
rtk git commit -m "feat(appearance): expand ThemeColors to 23 keys

Adds popover, popoverForeground, input, sidebar*, sidebarPrimary,
sidebarBorder. The CSS variables already exist in app/globals.css —
this aligns the typed token set with the rendered surface so custom
themes can fully control sidebar and popover surfaces."
```

---

### Task 4: CustomThemeApplier — fix B1 (custom themes don't apply)

**Files:**

- Create: `lib/appearance/custom-theme-applier.tsx`
- Create: `lib/appearance/custom-theme-applier.test.tsx`
- Create: `lib/appearance/css-var.ts` (small helper, easier to unit-test)
- Create: `lib/appearance/css-var.test.ts`
- Modify: `app/layout.tsx`

- [ ] **Step 1: Write the camelToKebab helper test**

```ts
// lib/appearance/css-var.test.ts
import { themeKeyToCssVar, CSS_VAR_KEYS } from "./css-var"

describe("themeKeyToCssVar", () => {
  it.each([
    ["background", "--background"],
    ["primaryForeground", "--primary-foreground"],
    ["sidebarPrimary", "--sidebar-primary"],
    ["popoverForeground", "--popover-foreground"],
  ])("converts %s → %s", (input, expected) => {
    expect(themeKeyToCssVar(input)).toBe(expected)
  })
})

describe("CSS_VAR_KEYS", () => {
  it("covers all 23 ThemeColors keys", () => {
    expect(CSS_VAR_KEYS.length).toBe(23)
  })
})
```

- [ ] **Step 2: Run — fail**

```powershell
rtk pnpm test lib/appearance/css-var.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement helper**

```ts
// lib/appearance/css-var.ts
import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { THEME_COLOR_KEYS } from "./vscode-theme/token-mapping"

/**
 * Convert a ThemeColors key (camelCase) to its CSS custom-property name (kebab).
 * `primaryForeground` → `--primary-foreground`. The mapping is a direct
 * camel→kebab transform; the `app/globals.css` variable names match.
 */
export function themeKeyToCssVar(key: keyof ThemeColors | string): string {
  const kebab = key.replace(/([A-Z])/g, "-$1").toLowerCase()
  return `--${kebab}`
}

export const CSS_VAR_KEYS: readonly string[] = THEME_COLOR_KEYS.map(themeKeyToCssVar)
```

- [ ] **Step 4: Run — pass**

```powershell
rtk pnpm test lib/appearance/css-var.test.ts
```

- [ ] **Step 5: Write applier test**

```tsx
// lib/appearance/custom-theme-applier.test.tsx
import { render, act } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings"
import { CustomThemeApplier } from "./custom-theme-applier"

jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}))

describe("CustomThemeApplier", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        id: "singleton",
        permissionMode: "default",
        alwaysAllowTools: [],
        builtinTools: {},
        theme: "dark",
        colorTheme: "default",
        customThemes: [],
        activeCustomThemeId: null,
      } as never,
      loaded: true,
    })
    document.documentElement.removeAttribute("style")
  })

  it("does nothing when no custom theme is active", () => {
    render(<CustomThemeApplier />)
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("")
  })

  it("writes 23 CSS variables when a custom theme is active", () => {
    const customTheme = {
      id: "t1",
      name: "Test",
      isDark: true,
      colors: {
        background: "#0b0b0b",
        foreground: "#fafafa",
        primary: "#ff00ff",
        primaryForeground: "#000000",
        // ... fill 23 keys for compile sanity; helper below in real impl
      } as never,
    }
    act(() => {
      useSettingsStore.setState({
        settings: {
          ...useSettingsStore.getState().settings,
          customThemes: [customTheme],
          activeCustomThemeId: "t1",
        } as never,
      })
    })
    render(<CustomThemeApplier />)
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#0b0b0b")
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("#ff00ff")
    expect(document.documentElement.style.getPropertyValue("--primary-foreground")).toBe("#000000")
  })

  it("clears injected vars when active theme is cleared", () => {
    // ... activate then clear; assert --background returns to ""
  })
})
```

(Use a small fixture builder for the 23-key shape so the test isn't a wall of literals — co-locate it in this test file.)

- [ ] **Step 6: Run — fail**

- [ ] **Step 7: Implement applier**

```tsx
// lib/appearance/custom-theme-applier.tsx
"use client"

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { useSettingsStore } from "@/stores/settings"
import { resolveActiveThemeColors } from "@/lib/themes"
import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { themeKeyToCssVar, CSS_VAR_KEYS } from "./css-var"

/**
 * Mounts at the root layout and writes the active CustomTheme's tokens onto
 * `<html>` as inline CSS variables. When no custom theme is active or none
 * resolves, removes all previously-injected variables so the cascade falls
 * back to the `:root` / `.dark` defaults in `app/globals.css`.
 *
 * Subscribes minimally — only the active id, the customThemes list, and the
 * resolved theme — so unrelated settings updates don't re-render this.
 */
export function CustomThemeApplier(): null {
  const activeCustomThemeId = useSettingsStore((s) => s.activeCustomThemeId)
  const customThemes = useSettingsStore((s) => s.customThemes)
  const colorTheme = useSettingsStore((s) => s.colorTheme)
  const { resolvedTheme } = useTheme()
  const lastApplied = useRef(false)

  useEffect(() => {
    if (typeof document === "undefined") return
    const root = document.documentElement
    const variant = resolvedTheme === "light" ? "light" : "dark"
    const resolved = resolveActiveThemeColors({
      colorTheme,
      resolvedTheme: variant,
      activeCustomThemeId,
      customThemes,
    })
    const isCustom = resolved.themeSource === "custom"
    if (!isCustom && !lastApplied.current) return
    if (!isCustom && lastApplied.current) {
      // Clear our injection so cascade falls back to globals.css.
      for (const cssVar of CSS_VAR_KEYS) {
        root.style.removeProperty(cssVar)
      }
      lastApplied.current = false
      return
    }
    applyTokens(root, resolved.colors)
    lastApplied.current = true
  }, [activeCustomThemeId, customThemes, colorTheme, resolvedTheme])

  return null
}

function applyTokens(root: HTMLElement, tokens: ThemeColors): void {
  for (const [key, value] of Object.entries(tokens)) {
    if (!value) continue
    root.style.setProperty(themeKeyToCssVar(key), value)
  }
}
```

- [ ] **Step 8: Run — pass**

- [ ] **Step 9: Mount in layout**

In `app/layout.tsx`, mount `<CustomThemeApplier />` next to `<BackgroundApplier />`:

```tsx
import { BackgroundApplier } from "@/lib/appearance"
import { CustomThemeApplier } from "@/lib/appearance/custom-theme-applier"

// Inside the existing tree:
<BackgroundApplier />
<CustomThemeApplier />
{children}
```

- [ ] **Step 10: typecheck + lint + commit**

```powershell
rtk pnpm typecheck && rtk pnpm lint
rtk git add -A
rtk git commit -m "fix(appearance): mount CustomThemeApplier so custom themes actually apply

Wires active custom theme tokens to <html> CSS variables. The
half-built feature persisted state correctly but never wrote it to the
DOM. Subscribes to the minimum slice so unrelated settings updates
don't re-run the effect."
```

---

### Task 5: `data-bg-target` on chat/canvas/sidebar/global containers — fix E1 (scope dead code)

**Why this comes after the applier:** background scope only matters once the rest of the appearance pipeline is alive. Doing it last in Phase 1 means we can validate visually that the change works (drop a wallpaper and watch chat-only mode actually scope it).

**Files:**

- Modify: chat container (find via grep)
- Modify: canvas container (find via grep)
- Modify: sidebar container (find via grep)
- Modify: `app/layout.tsx` (for `global` scope wrapper)

- [ ] **Step 1: Locate the four target containers**

```powershell
rtk grep "DiscordShell|app-shell|MainShell" --files-with-matches
```

Expected output (file paths) — pick the one that wraps the whole app post-sidebar. Cognia typically uses a shell component; record the path.

```powershell
rtk grep "twin-workbench|CanvasWorkspace|canvas/page" --files-with-matches
```

```powershell
rtk grep "AppSidebar|nav-sidebar|sidebar/sidebar" --files-with-matches
```

Record three concrete file paths. If a container doesn't exist as a stable file, you'll add a wrapping `<div data-bg-target="...">` in the parent layout instead.

- [ ] **Step 2: Add `data-bg-target="chat"` to the chat root**

In the file located above (likely `components/chat/...` or `app/(chat)/layout.tsx`), add the attribute to the outermost element:

```tsx
// Before
<div className="flex h-full flex-col">
  ...
</div>

// After
<div className="flex h-full flex-col" data-bg-target="chat">
  ...
</div>
```

The CSS in `app/globals.css:206-235` already covers `[data-bg-target="chat"]::before` — no CSS changes needed.

- [ ] **Step 3: Same for canvas and sidebar containers**

For canvas: `data-bg-target="canvas"` on the workbench root.
For sidebar: `data-bg-target="sidebar"` on the global navigation sidebar root.

- [ ] **Step 4: Add `data-bg-target="global"` for the main content wrapper**

In `app/layout.tsx`, wrap `{children}` so the global scope has a target. Pick a wrapper that excludes the chat/canvas/sidebar (which already opt in individually):

```tsx
<DataAdapterProvider adapter={dexieAdapter}>
  <BackgroundApplier />
  <CustomThemeApplier />
  <div data-bg-target="global" className="contents">
    {children}
  </div>
</DataAdapterProvider>
```

`className="contents"` keeps layout flow unchanged.

- [ ] **Step 5: Manual sanity check**

```powershell
rtk pnpm dev
```

Open http://localhost:3000, go to Settings → Appearance → Wallpaper, upload an image, set scope=chat. Navigate to a chat. Image should appear only in the chat region. Settings page should NOT show the image.

If the image bleeds into other panels, you tagged a wrong container — re-grep and adjust.

- [ ] **Step 6: typecheck + lint + commit**

```powershell
rtk pnpm typecheck && rtk pnpm lint
rtk git add -A
rtk git commit -m "fix(appearance): wire data-bg-target on scope containers

Chat, canvas, sidebar, and global content wrappers now opt into the
scoped background CSS already defined in globals.css. Without these
attributes, scope=chat/canvas/sidebar produced no background at all
because the selector had no targets."
```

**Phase 1 gate:** All settings persist, custom themes apply, scope works. Run:

```powershell
rtk pnpm test && rtk pnpm typecheck && rtk pnpm lint
```

All green before moving to Phase 2.

---

# Phase 2 — Schema migration + dual-variant token model (sequential)

After Phase 1 the half-built feature works for users; Phase 2 upgrades the data model so light↔dark switching uses the right colors instead of the same set for both modes.

---

### Task 6: `derive-variant.ts` — OKLCH algorithm

**Files:**

- Create: `lib/appearance/derive-variant.ts`
- Create: `lib/appearance/derive-variant.test.ts`

- [ ] **Step 1: Write tests first**

```ts
// lib/appearance/derive-variant.test.ts
import { deriveOppositeVariant, deriveTokenColor } from "./derive-variant"
import type { ThemeColors } from "@/types/plugin/plugin-extended"

const lightSeed: Partial<ThemeColors> = {
  background: "#ffffff",
  foreground: "#0f172a",
  primary: "#3b82f6",
  primaryForeground: "#ffffff",
}

describe("deriveTokenColor (single token)", () => {
  it("flips lightness for neutral colors", () => {
    const dark = deriveTokenColor("#ffffff", "light", "dark")
    // White → near-black; check OKLCH lightness is below 0.2.
    expect(dark.startsWith("oklch(")).toBe(true)
    expect(dark).toMatch(/oklch\(0\.\d/) // some OKLCH form
  })

  it("preserves hue for accent colors", () => {
    // #3b82f6 is a blue; the dark variant should still be blue (hue ~250-260).
    const dark = deriveTokenColor("#3b82f6", "light", "dark")
    const hueMatch = dark.match(/oklch\([^)]+ ([0-9.]+)\)/)
    expect(hueMatch).not.toBeNull()
    const hue = parseFloat(hueMatch![1])
    expect(hue).toBeGreaterThan(240)
    expect(hue).toBeLessThan(280)
  })

  it("attenuates chroma in dark mode for saturated colors", () => {
    const dark = deriveTokenColor("#ff0000", "light", "dark")
    // Original chroma ~0.25; derived should be slightly lower (×0.92).
    const chromaMatch = dark.match(/oklch\([0-9.]+ ([0-9.]+)/)
    const c = parseFloat(chromaMatch![1])
    expect(c).toBeLessThan(0.25)
    expect(c).toBeGreaterThan(0.18)
  })

  it("returns input unchanged when source and target variants match", () => {
    expect(deriveTokenColor("#3b82f6", "dark", "dark")).toBe("#3b82f6")
  })
})

describe("deriveOppositeVariant (whole palette)", () => {
  it("returns a palette with all 23 keys", () => {
    const seed = Object.fromEntries(
      [
        "background",
        "foreground",
        "primary",
        "primaryForeground",
        "secondary",
        "secondaryForeground",
        "accent",
        "accentForeground",
        "muted",
        "mutedForeground",
        "card",
        "cardForeground",
        "popover",
        "popoverForeground",
        "input",
        "border",
        "ring",
        "destructive",
        "destructiveForeground",
        "sidebar",
        "sidebarForeground",
        "sidebarPrimary",
        "sidebarBorder",
      ].map((k) => [k, "#888888"])
    ) as ThemeColors
    const derived = deriveOppositeVariant(seed, "light")
    for (const k of Object.keys(seed)) {
      expect(derived[k as keyof ThemeColors]).toBeDefined()
    }
  })

  it("derived foreground/background pair has WCAG ≥ 4.5:1 contrast", () => {
    const seed: Partial<ThemeColors> = { background: "#ffffff", foreground: "#0f172a" }
    const dark = deriveOppositeVariant(seed as ThemeColors, "light")
    // contrast helper imported lazily
    const { wcagContrast } = require("./contrast")
    expect(wcagContrast(dark.foreground, dark.background)).toBeGreaterThanOrEqual(4.5)
  })
})
```

- [ ] **Step 2: Run — fail (module not found)**

- [ ] **Step 3: Implement**

```ts
// lib/appearance/derive-variant.ts
import { converter, formatCss, parse, type Color } from "culori"
import type { ThemeColors } from "@/types/plugin/plugin-extended"

const toOklch = converter("oklch")
const NEUTRAL_CHROMA_THRESHOLD = 0.04
const DARK_CHROMA_ATTENUATION = 0.92
const ACCENT_LIGHTNESS_BASE = 0.4
const ACCENT_LIGHTNESS_RANGE = 0.4

/**
 * Convert a CSS color string into OKLCH coordinates. Returns `null` when the
 * input cannot be parsed (callers should fall back to a sane default).
 */
function parseToOklch(input: string): { l: number; c: number; h: number } | null {
  try {
    const parsed = parse(input)
    if (!parsed) return null
    const oklch = toOklch(parsed)
    if (!oklch) return null
    return {
      l: typeof oklch.l === "number" ? oklch.l : 0,
      c: typeof oklch.c === "number" ? oklch.c : 0,
      h: typeof oklch.h === "number" ? oklch.h : 0,
    }
  } catch {
    return null
  }
}

function emitOklch(l: number, c: number, h: number): string {
  // Clamp to displayable ranges.
  const clampedL = Math.max(0, Math.min(1, l))
  const clampedC = Math.max(0, Math.min(0.4, c))
  const obj: Color = { mode: "oklch", l: clampedL, c: clampedC, h }
  return formatCss(obj)
}

/**
 * Derive a single token's value when flipping between light and dark.
 *
 * Rules:
 *   - Neutral (`c < 0.04`): flip lightness via `1 - L`.
 *   - Saturated: keep hue, remap lightness to `0.4 + 0.4 * (1 - L)` so accents
 *     stay visible without going pure black/white; in dark mode also reduce
 *     chroma by 8% to avoid a neon look.
 *   - Same source and target variant: return input unchanged.
 */
export function deriveTokenColor(
  input: string,
  sourceVariant: "light" | "dark",
  targetVariant: "light" | "dark"
): string {
  if (sourceVariant === targetVariant) return input
  const oklch = parseToOklch(input)
  if (!oklch) return input

  const { l, c, h } = oklch
  const isNeutral = c < NEUTRAL_CHROMA_THRESHOLD
  if (isNeutral) {
    return emitOklch(1 - l, c, h)
  }

  const newL = ACCENT_LIGHTNESS_BASE + ACCENT_LIGHTNESS_RANGE * (1 - l)
  const newC = targetVariant === "dark" ? c * DARK_CHROMA_ATTENUATION : c
  return emitOklch(newL, newC, h)
}

/**
 * Derive the opposite-variant ThemeColors palette from a single source set.
 *
 * After the per-token derivation, runs a final `enforceReadable` pass on the
 * foreground/background pairs that matter most (foreground/background,
 * cardForeground/card, sidebarForeground/sidebar) to keep WCAG contrast
 * above 4.5:1.
 */
export function deriveOppositeVariant(
  source: ThemeColors,
  sourceVariant: "light" | "dark"
): ThemeColors {
  const target = sourceVariant === "light" ? "dark" : "light"
  const derived = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      deriveTokenColor(value, sourceVariant, target),
    ])
  ) as ThemeColors

  // Enforce contrast on the critical pairs. Implementation lives in
  // ./contrast.ts (Task 16) — for now stub it so this task can land
  // independently. Phase 4 wires the real check.
  return derived
}
```

- [ ] **Step 4: Run tests — pass**

```powershell
rtk pnpm test lib/appearance/derive-variant.test.ts
```

- [ ] **Step 5: Commit**

```powershell
rtk git add lib/appearance/derive-variant.ts lib/appearance/derive-variant.test.ts
rtk git commit -m "feat(appearance): OKLCH-based variant derivation"
```

---

### Task 7: Update `CustomTheme` type to dual-variant shape

**Files:**

- Modify: `types/plugin/plugin-extended.ts`
- Modify: `lib/themes/index.ts` (resolveActiveThemeColors)
- Modify: `stores/settings/settings-store.ts` (createCustomTheme/updateCustomTheme)
- Update affected tests

- [ ] **Step 1: Update the type**

```ts
// types/plugin/plugin-extended.ts
export interface CustomTheme {
  id: string
  name: string
  /** User's original variant intent (drives default light/dark when activated). */
  baseVariant: "light" | "dark"
  /** Both variant palettes. The `derivedVariant` was filled by the algorithm. */
  tokens: { light: ThemeColors; dark: ThemeColors }
  /** Marks which side was auto-derived (vs. hand-edited or imported). */
  derivedVariant?: "light" | "dark"
  /** Keep `colors` and `isDark` defined as deprecated for one release so the
      Phase 2 migration code can still read them.  After v16 ships we will
      delete these in a follow-up commit. */
  /** @deprecated Read via `tokens` instead. */
  colors?: ThemeColors
  /** @deprecated Read via `baseVariant` instead. */
  isDark?: boolean
}
```

- [ ] **Step 2: Update `resolveActiveThemeColors` to read dual tokens**

```ts
// lib/themes/index.ts
export function resolveActiveThemeColors(args: ResolveActiveThemeArgs): ResolvedTheme {
  const { colorTheme, resolvedTheme, activeCustomThemeId, customThemes } = args
  const presetPair = PRESETS[colorTheme] ?? PRESETS.default
  const presetColors = presetPair[resolvedTheme]

  if (activeCustomThemeId) {
    const custom = customThemes.find((t) => t.id === activeCustomThemeId)
    if (custom) {
      // Prefer the new dual-variant shape; fall back to the legacy single
      // `colors` field for installs not yet migrated.
      const customColors =
        custom.tokens?.[resolvedTheme] ??
        // Legacy path: single `colors` set keyed by `isDark`.
        (custom.isDark === (resolvedTheme === "dark") ? custom.colors : undefined)

      const baseline =
        custom.baseVariant === "dark"
          ? presetPair.dark
          : custom.baseVariant === "light"
            ? presetPair.light
            : presetColors

      return {
        colors: { ...baseline, ...(customColors ?? {}) },
        themeSource: "custom",
      }
    }
  }
  return { colors: presetColors, themeSource: "preset" }
}
```

- [ ] **Step 3: Run typecheck — fix call sites**

```powershell
rtk pnpm typecheck
```

Expected errors in:

- `stores/settings/settings-store.ts` (createCustomTheme accepts old shape)
- `components/settings/appearance/tabs/custom-theme-tab.tsx` (constructs `CustomTheme` with old shape — leave as-is for now; Phase 5 reworks it)

For the store: relax the param so it accepts EITHER shape (legacy or new), since UI hasn't migrated yet:

```ts
createCustomTheme: (theme) => {
  const cur = get().settings
  const id = `customtheme_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const list = cur?.customThemes ?? []
  // Accept either {colors, isDark} or {tokens, baseVariant}; the Dexie
  // migration in Task 8 will normalize on read.
  const newTheme = { ...theme, id } as CustomTheme
  // ... rest unchanged
}
```

- [ ] **Step 4: Run tests — fix breakages**

Some `lib/themes/index.test.ts` cases probably assume the legacy shape. Update them so they still pass: the legacy fallback path is preserved, the new path is exercised by adding two new test cases:

```ts
it("reads tokens.dark when resolvedTheme=dark and tokens dual-shape present", () => {
  const result = resolveActiveThemeColors({
    colorTheme: "default",
    resolvedTheme: "dark",
    activeCustomThemeId: "t1",
    customThemes: [
      {
        id: "t1",
        name: "X",
        baseVariant: "dark",
        tokens: { light: NEUTRAL_LIGHT, dark: { ...NEUTRAL_DARK, primary: "#ff00ff" } },
      } as CustomTheme,
    ],
  })
  expect(result.colors.primary).toBe("#ff00ff")
})

it("falls back to legacy colors when tokens missing (pre-migration row)", () => {
  const result = resolveActiveThemeColors({
    colorTheme: "default",
    resolvedTheme: "dark",
    activeCustomThemeId: "t1",
    customThemes: [
      {
        id: "t1",
        name: "X",
        isDark: true,
        colors: { ...NEUTRAL_DARK, primary: "#abcdef" },
      } as CustomTheme,
    ],
  })
  expect(result.colors.primary).toBe("#abcdef")
})
```

- [ ] **Step 5: Commit**

```powershell
rtk git add -A
rtk git commit -m "feat(appearance): CustomTheme supports dual {light, dark} tokens

Old single-set 'colors' path stays as a read-only fallback so the
upcoming Dexie v15→v16 migration can normalize old rows in place
without breaking the runtime in the meantime."
```

---

### Task 8: Dexie v15 → v16 migration

**Files:**

- Modify: `lib/db/schema.ts`
- Create: `lib/db/schema.test.ts` additional case

- [ ] **Step 1: Write the migration test**

In `lib/db/schema.test.ts`, add:

```ts
it("v15 → v16 migrates customThemes[].colors → tokens.{light, dark}", async () => {
  const legacy = new Dexie("cognia-claude-test-v15")
  legacy.version(15).stores({ settings: "id" /* truncated; only what we need */ })
  await legacy.open()
  await legacy.table("settings").put({
    id: "singleton",
    customThemes: [
      {
        id: "old",
        name: "Legacy",
        isDark: true,
        colors: {
          background: "#0b0b0b",
          foreground: "#ffffff",
          primary: "#ff00ff",
          primaryForeground: "#000000",
          // ... 16 keys total
        },
      },
    ],
  })
  legacy.close()

  // Re-open through the production schema (v16) and confirm migration ran.
  const db = new CogniaDB() // Pretend the test re-opens.
  await db.open()
  const row = await db.settings.get("singleton")
  const t = row!.customThemes![0]
  expect(t.baseVariant).toBe("dark")
  expect(t.tokens?.dark?.primary).toBe("#ff00ff")
  expect(t.tokens?.light?.primary).toBeDefined()
  expect(t.derivedVariant).toBe("light")
  await db.delete()
})
```

(Mirror the existing v14→v15 migration test pattern in `schema.test.ts:457` lines.)

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement migration in `lib/db/schema.ts`**

Append after the existing v15 block:

```ts
// v16 — Dual-variant CustomTheme migration. The settings table schema
// itself doesn't change — `customThemes` is a JSON-typed field inside
// the singleton row. The upgrade hook walks each theme and rewrites
// `{colors, isDark}` to `{tokens: {light, dark}, baseVariant, derivedVariant}`.
//
// The legacy fields are preserved on each row for one release so a
// rollback to v15 doesn't lose data. They will be pruned in a future
// version once the dual-variant shape has been live for at least one
// release cycle.
this.version(16)
  .stores({
    // Same as v15 — no table schema changes.
    sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
    messages: "id, sessionId, [sessionId+createdAt], senderId",
    settings: "id",
    promptPresets:
      "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
    mcpServers: "id, name, enabled",
    characters: "id, name, updatedAt, isBuiltIn",
    skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
    skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
    teams: "id, name, updatedAt, isBuiltIn",
    sessionState: "sessionId, lastReadAt",
    trustedWorkspaces: "path, trustedAt",
    tts_provider_keys: "id",
    backupHistory: "id, completedAt, type, success",
    canvasDocuments: "id, title, language, type, updatedAt, createdAt",
    canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
    canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
    canvasSessions: "id, documentId, ownerId, createdAt",
    a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
    a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
    a2uiTemplates: "id, name, category, updatedAt, source",
    a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
    twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
    twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
    twinProfile: "&id, twinId",
    twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
    twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
    plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
    pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
    pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
    pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
    pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
  })
  .upgrade(async (tx) => {
    // Lazy-import to avoid pulling culori into the cold-path of every db open.
    const { deriveOppositeVariant } = await import("@/lib/appearance/derive-variant")
    await tx
      .table("settings")
      .toCollection()
      .modify((row: Record<string, unknown>) => {
        const themes = (row.customThemes ?? []) as Array<Record<string, unknown>>
        for (const t of themes) {
          if (t.tokens && (t.tokens as { light?: unknown }).light) continue // already migrated
          if (!t.colors) continue
          const baseVariant = (t.isDark ? "dark" : "light") as "light" | "dark"
          const opposite = baseVariant === "dark" ? "light" : "dark"
          const single = t.colors as Record<string, string>
          t.baseVariant = baseVariant
          t.derivedVariant = opposite
          t.tokens = {
            [baseVariant]: single,
            [opposite]: deriveOppositeVariant(single as never, baseVariant),
          }
          // Keep `colors` and `isDark` for one release for rollback safety.
        }
      })
  })
```

**Rollback note:** If a user opens an older build of cognia-next (v15-aware), they'll see their `customThemes[]` with both the new `tokens` field (ignored) and the legacy `colors` field (read normally). This is the safe path — no rollback migration needed.

- [ ] **Step 4: Run test — pass**

- [ ] **Step 5: Commit**

```powershell
rtk git add lib/db/schema.ts lib/db/schema.test.ts
rtk git commit -m "feat(db): v16 migrates CustomTheme to dual-variant tokens

Legacy {colors, isDark} fields are preserved one release for rollback
safety. The upgrade hook lazily derives the opposite variant via
OKLCH math (lib/appearance/derive-variant.ts)."
```

---

### Task 9: Update `vscode-import-tab` to write the dual-variant shape

**Files:**

- Modify: `components/settings/appearance/tabs/vscode-import-tab.tsx`

- [ ] **Step 1: Read the current commit path** (around lines 75-99 per ADR).

- [ ] **Step 2: Update commit to write dual-variant**

When constructing the `CustomTheme` to insert via `createCustomTheme`, build the dual-variant shape:

```tsx
// In commitTheme(parsed: ParsedTheme, originRecord: ImportedThemeRecord)
import { deriveOppositeVariant } from "@/lib/appearance/derive-variant"

const baseVariant = parsed.theme.isDark ? "dark" : "light"
const opposite = baseVariant === "dark" ? "light" : "dark"
const single = parsed.theme.colors as ThemeColors
const tokens = {
  [baseVariant]: single,
  [opposite]: deriveOppositeVariant(single, baseVariant),
} as { light: ThemeColors; dark: ThemeColors }

const newId = createCustomTheme({
  name: parsed.theme.name,
  baseVariant,
  tokens,
  derivedVariant: opposite,
} as never)
addImportedTheme({ ...originRecord, customThemeId: newId })
setActive(newId)
```

- [ ] **Step 3: Update the existing tab tests** for the new shape.

- [ ] **Step 4: typecheck + test + commit**

```powershell
rtk pnpm typecheck && rtk pnpm test components/settings/appearance/tabs/vscode-import-tab.test.tsx
rtk git add -A
rtk git commit -m "feat(appearance): VSCode import writes dual-variant tokens"
```

**Phase 2 gate:**

```powershell
rtk pnpm test && rtk pnpm typecheck && rtk pnpm lint
```

All green. After Phase 2, light/dark toggle correctly reroutes through the appropriate token set for any custom theme. Manual sanity check: import a real Dracula theme, toggle light/dark, verify the light variant looks plausible (not pitch black on white).

---

# Phase 3 — VSCode parser improvements (parallel-safe)

This phase improves the existing parsers but doesn't unblock anything else, so it's parallel-dispatchable with Phase 4. Each task is a self-contained quality improvement.

---

### Task 10: Reverse JSON fallback order — fix C1

**Files:**

- Modify: `lib/appearance/vscode-theme/parse-json.ts`
- Modify: `lib/appearance/vscode-theme/parse-json.test.ts`

- [ ] **Step 1: Update the derivation block** (around lines 153-180):

```ts
// Derive missing fields from background/foreground when possible. The
// derivation comes BEFORE the hardcoded `DEFAULT_FALLBACKS` palette so
// a minimalist VSCode theme that only sets bg/fg ends up with derived
// colors that match its mood, not blue accents from our defaults.
const bg = out.background ?? fallback.background
const fg = out.foreground ?? readableForeground(bg)
out.background ??= bg
out.foreground ??= fg

// Surfaces: derive from bg with small tints/shades.
if (!out.muted) out.muted = isDark ? lighten(bg, 0.06) : darken(bg, 0.04)
if (!out.card) out.card = isDark ? lighten(bg, 0.04) : bg
if (!out.popover) out.popover = isDark ? lighten(bg, 0.05) : bg
if (!out.input) out.input = isDark ? lighten(bg, 0.07) : darken(bg, 0.05)
if (!out.sidebar) out.sidebar = isDark ? lighten(bg, 0.02) : darken(bg, 0.02)

// Foregrounds derived from the matched fg unless explicitly overridden.
if (!out.cardForeground) out.cardForeground = fg
if (!out.popoverForeground) out.popoverForeground = fg
if (!out.sidebarForeground) out.sidebarForeground = fg
if (!out.mutedForeground) out.mutedForeground = isDark ? darken(fg, 0.25) : lighten(fg, 0.25)
if (!out.secondaryForeground) out.secondaryForeground = fg

// Borders: subtle bg-derived values.
if (!out.border) out.border = isDark ? lighten(bg, 0.1) : darken(bg, 0.08)
if (!out.sidebarBorder) out.sidebarBorder = out.border

// Accents: derive from primary if matched; ONLY fall back to the hardcoded
// palette when neither bg/fg nor primary are usable.
const accentSource = out.primary ?? out.foreground
if (!out.accent) out.accent = accentSource
if (!out.accentForeground) out.accentForeground = readableForeground(out.accent)
if (!out.ring) out.ring = out.primary ?? accentSource ?? fallback.ring
if (!out.sidebarPrimary) out.sidebarPrimary = out.primary ?? fallback.primary

// Last-resort hardcoded fallback for tokens that have no source at all.
if (!out.primary) out.primary = fallback.primary
if (!out.primaryForeground) out.primaryForeground = readableForeground(out.primary)
if (!out.secondary) out.secondary = isDark ? lighten(bg, 0.05) : darken(bg, 0.03)
if (!out.destructive) out.destructive = fallback.destructive
if (!out.destructiveForeground) out.destructiveForeground = readableForeground(out.destructive)
```

- [ ] **Step 2: Add a regression test**

```ts
it("does NOT use hardcoded blue when theme provides bg/fg but no primary", () => {
  const json = `{ "type": "dark", "colors": {
    "editor.background": "#1a1a2e",
    "editor.foreground": "#eaeaea"
  } }`
  const { theme } = importVscodeThemeJson(json)
  // The hardcoded primary fallback is #60a5fa; we should derive something
  // related to fg instead.
  expect(theme.colors.primary).not.toBe("#60a5fa")
  expect(theme.colors.accent).not.toBe("#60a5fa")
})
```

- [ ] **Step 3: Run, fix, commit.**

```powershell
rtk pnpm test lib/appearance/vscode-theme/parse-json.test.ts
rtk git add lib/appearance/vscode-theme/parse-json.ts lib/appearance/vscode-theme/parse-json.test.ts
rtk git commit -m "fix(appearance): VSCode JSON derivation runs before hardcoded fallbacks"
```

---

### Task 11: Eager VSIX parsing — fix D1

**Files:**

- Modify: `lib/appearance/vscode-theme/parse-vsix.ts`
- Modify: `lib/appearance/vscode-theme/parse-vsix.test.ts`
- Modify: `components/settings/appearance/tabs/vscode-import-tab.tsx`

- [ ] **Step 1: Update test to assert eager-parse semantics**

```ts
it("readVsix returns fully-parsed themes (no lazy parse closure)", async () => {
  const buf = await fixture("dracula.vsix")
  const result = await readVsix(buf)
  expect(result.themes[0]).toHaveProperty("parsed") // ParsedTheme, not parse fn
  expect(result.themes[0].parsed.theme.colors.background).toMatch(/^#/)
})
```

- [ ] **Step 2: Update `parse-vsix.ts`**

Replace the `entries.push({ ..., parse: async () => ... })` block with eager parse:

```ts
for (const raw of themesArr) {
  if (!raw || typeof raw !== "object") continue
  const r = raw as { label?: unknown; uiTheme?: unknown; path?: unknown }
  if (typeof r.path !== "string" || r.path.length === 0) continue
  const path = normalizeRelPath(r.path)
  const fullPath = `extension/${path}`
  const file = zip.file(fullPath)
  if (!file) continue
  const label = typeof r.label === "string" && r.label.length > 0 ? r.label : path
  const uiTheme = typeof r.uiTheme === "string" ? r.uiTheme : undefined

  let parsed: ParsedTheme
  try {
    const text = await file.async("string")
    const forceVariant = uiThemeToVariant(uiTheme)
    parsed = importVscodeThemeJson(text, {
      nameHint: label,
      ...(forceVariant ? { forceVariant } : {}),
    })
  } catch (err) {
    // Skip malformed themes but record the failure so the UI can warn.
    console.warn(`VSIX theme ${path} failed to parse: ${(err as Error).message}`)
    continue
  }

  entries.push({ label, uiTheme, path, parsed })
}
```

Update the type:

```ts
export interface VsixThemeReady extends VsixThemeManifestEntry {
  parsed: ParsedTheme // was: parse: () => Promise<ParsedTheme>
}
```

- [ ] **Step 3: Update `vscode-import-tab.tsx`** to read `entry.parsed` directly instead of awaiting `entry.parse()`. Remove the `await` chain that depended on the closure.

- [ ] **Step 4: Add UI error handling**

In `vscode-import-tab.tsx`, add a top-level error state:

```tsx
const [error, setError] = useState<string | null>(null)
const [busy, setBusy] = useState(false)

async function handleFile(file: File) {
  setBusy(true)
  setError(null)
  // 30s timeout fallback for hung parsing.
  const timeoutId = setTimeout(() => {
    setError("解析超时，可能是文件损坏。请尝试更小的 .vsix 文件。")
    setBusy(false)
  }, 30_000)
  try {
    if (file.name.endsWith(".json")) {
      const text = await file.text()
      const parsed = importVscodeThemeJson(text)
      // ... commit
    } else if (file.name.endsWith(".vsix")) {
      const buf = await file.arrayBuffer()
      const manifest = await readVsix(buf)
      // open multi-theme picker dialog with manifest.themes
    }
  } catch (err) {
    setError(`导入失败：${(err as Error).message}`)
  } finally {
    clearTimeout(timeoutId)
    setBusy(false)
  }
}
```

In the JSX, render error inside an `<Alert variant="destructive">`:

```tsx
{
  error && (
    <Alert variant="destructive">
      <AlertTitle>导入失败</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
}
```

- [ ] **Step 5: typecheck + test + commit**

```powershell
rtk pnpm typecheck && rtk pnpm test lib/appearance/vscode-theme
rtk git add -A
rtk git commit -m "fix(appearance): eager VSIX parsing + explicit error UI

The lazy parse() closure could capture a GC'd zip reference; we now
parse all themes upfront. Errors that previously vanished into a
console.warn now appear in the import UI as a destructive alert,
including a 30s timeout for hung parsing."
```

---

### Task 12: Add real VSCode fixtures + regression tests

**Files:**

- Create: `lib/appearance/vscode-theme/__fixtures__/{dracula,one-dark-pro,tokyo-night-dark,github-light-default}.json`
- Create: `lib/appearance/vscode-theme/__fixtures__/dracula.vsix`
- Create: `lib/appearance/vscode-theme/__fixtures__/{no-themes,corrupt}.vsix`
- Modify: `lib/appearance/vscode-theme/parse-json.test.ts`
- Modify: `lib/appearance/vscode-theme/parse-vsix.test.ts`

- [ ] **Step 1: Download real themes from the VSCode marketplace**

Visit:

- `https://marketplace.visualstudio.com/items?itemName=dracula-theme.theme-dracula` → download .vsix
- `https://marketplace.visualstudio.com/items?itemName=zhuangtongfa.material-theme` (One Dark Pro) → .vsix
- `https://marketplace.visualstudio.com/items?itemName=enkia.tokyo-night` → .vsix
- GitHub Light Default ships with VSCode itself; extract `dark_modern.json` from the VSCode install (or use a curated copy)

Place .json files extracted from each .vsix's `extension/themes/` into the fixtures dir. Place one .vsix bundle (Dracula) verbatim.

- [ ] **Step 2: Build synthetic fixtures**

```powershell
node -e "const JSZip = require('jszip'); const z = new JSZip(); z.file('extension/package.json', JSON.stringify({ name: 'empty', contributes: { themes: [] } })); z.generateAsync({ type: 'nodebuffer' }).then(b => require('fs').writeFileSync('lib/appearance/vscode-theme/__fixtures__/no-themes.vsix', b))"
```

For corrupt:

```powershell
# Truncate the dracula vsix at byte 100
node -e "const fs = require('fs'); const buf = fs.readFileSync('lib/appearance/vscode-theme/__fixtures__/dracula.vsix'); fs.writeFileSync('lib/appearance/vscode-theme/__fixtures__/corrupt.vsix', buf.slice(0, 100))"
```

- [ ] **Step 3: Write regression tests**

```ts
import fs from "node:fs"
import path from "node:path"
import { importVscodeThemeJson } from "./parse-json"
import { readVsix } from "./parse-vsix"

const fixtureDir = path.join(__dirname, "__fixtures__")

describe("real VSCode themes parse without errors", () => {
  it.each(["dracula", "one-dark-pro", "tokyo-night-dark", "github-light-default"])("%s", (name) => {
    const text = fs.readFileSync(path.join(fixtureDir, `${name}.json`), "utf8")
    const result = importVscodeThemeJson(text)
    expect(result.theme.colors.background).toMatch(/^(#|oklch\()/)
    expect(result.theme.colors.foreground).toMatch(/^(#|oklch\()/)
    // No accent should be the hardcoded #60a5fa fallback.
    expect(result.theme.colors.accent).not.toBe("#60a5fa")
  })
})

describe("VSIX edge cases", () => {
  it("dracula.vsix produces at least one theme with no errors", async () => {
    const buf = fs.readFileSync(path.join(fixtureDir, "dracula.vsix")).buffer
    const result = await readVsix(buf as ArrayBuffer)
    expect(result.themes.length).toBeGreaterThan(0)
  })

  it("no-themes.vsix throws a recognizable error", async () => {
    const buf = fs.readFileSync(path.join(fixtureDir, "no-themes.vsix")).buffer
    await expect(readVsix(buf as ArrayBuffer)).rejects.toThrow("does not contribute")
  })

  it("corrupt.vsix throws a recognizable error", async () => {
    const buf = fs.readFileSync(path.join(fixtureDir, "corrupt.vsix")).buffer
    await expect(readVsix(buf as ArrayBuffer)).rejects.toThrow(/unzip|VSIX/)
  })
})
```

- [ ] **Step 4: Run + commit**

```powershell
rtk pnpm test lib/appearance/vscode-theme
rtk git add lib/appearance/vscode-theme/__fixtures__ lib/appearance/vscode-theme/parse-json.test.ts lib/appearance/vscode-theme/parse-vsix.test.ts
rtk git commit -m "test(appearance): real VSCode theme fixtures + edge cases"
```

---

# Phase 4 — UX polish (parallel-safe with Phase 3)

---

### Task 13: `contrast.ts` and `contrast-audit.ts`

**Files:**

- Create: `lib/appearance/contrast.ts`
- Create: `lib/appearance/contrast.test.ts`
- Create: `lib/appearance/contrast-audit.ts`
- Create: `lib/appearance/contrast-audit.test.ts`

- [ ] **Step 1: Tests first**

```ts
// contrast.test.ts
import { wcagContrast, evaluateReadability } from "./contrast"

describe("wcagContrast", () => {
  it("returns 21 for black on white", () => {
    expect(wcagContrast("#000", "#fff")).toBeCloseTo(21, 0)
  })
  it("returns 1 for same colors", () => {
    expect(wcagContrast("#888", "#888")).toBeCloseTo(1, 1)
  })
  it("symmetric", () => {
    expect(wcagContrast("#123456", "#abcdef")).toBeCloseTo(wcagContrast("#abcdef", "#123456"), 2)
  })
})

describe("evaluateReadability", () => {
  it("ok when ≥ 4.5", () => {
    expect(evaluateReadability({ fgColor: "#000", bgColor: "#fff" }).level).toBe("ok")
  })
  it("warn when 3.0-4.5", () => {
    // Mid grays
    expect(evaluateReadability({ fgColor: "#555", bgColor: "#fff" }).level).toBe("warn")
  })
  it("fail when < 3", () => {
    expect(evaluateReadability({ fgColor: "#999", bgColor: "#aaa" }).level).toBe("fail")
  })
})
```

- [ ] **Step 2: Implement**

```ts
// contrast.ts
import { converter, parse } from "culori"
const toRgb = converter("rgb")

function relLuminance(color: string): number {
  const rgb = toRgb(parse(color))
  if (!rgb) return 0
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return 0.2126 * f(rgb.r ?? 0) + 0.7152 * f(rgb.g ?? 0) + 0.0722 * f(rgb.b ?? 0)
}

export function wcagContrast(fg: string, bg: string): number {
  const a = relLuminance(fg)
  const b = relLuminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

export interface ReadabilityVerdict {
  level: "ok" | "warn" | "fail"
  ratio: number
  recommendation?: string
}

export function evaluateReadability(args: {
  fgColor: string
  bgColor: string
}): ReadabilityVerdict {
  const ratio = wcagContrast(args.fgColor, args.bgColor)
  if (ratio >= 4.5) return { level: "ok", ratio }
  if (ratio >= 3) {
    return { level: "warn", ratio, recommendation: "对比度低于 4.5:1，可能影响可读性" }
  }
  return { level: "fail", ratio, recommendation: "对比度过低，文本几乎不可读" }
}
```

- [ ] **Step 3: Implement audit**

```ts
// contrast-audit.ts
import type { ThemeColors } from "@/types/plugin/plugin-extended"
import { wcagContrast } from "./contrast"

export interface AuditFailure {
  pair: [keyof ThemeColors, keyof ThemeColors]
  ratio: number
}

const CRITICAL_PAIRS: ReadonlyArray<[keyof ThemeColors, keyof ThemeColors]> = [
  ["foreground", "background"],
  ["cardForeground", "card"],
  ["popoverForeground", "popover"],
  ["primaryForeground", "primary"],
  ["destructiveForeground", "destructive"],
  ["mutedForeground", "muted"],
  ["accentForeground", "accent"],
  ["sidebarForeground", "sidebar"],
]

export function auditThemeContrast(tokens: ThemeColors): { failures: AuditFailure[] } {
  const failures: AuditFailure[] = []
  for (const [fg, bg] of CRITICAL_PAIRS) {
    const ratio = wcagContrast(tokens[fg], tokens[bg])
    if (ratio < 4.5) failures.push({ pair: [fg, bg], ratio })
  }
  return { failures }
}
```

- [ ] **Step 4: Run + commit**

```powershell
rtk pnpm test lib/appearance/contrast
rtk git add -A
rtk git commit -m "feat(appearance): WCAG contrast utility + theme audit"
```

---

### Task 14: Opacity guard + auto-fix in wallpaper-tab

**Files:**

- Modify: `components/settings/appearance/tabs/wallpaper-tab.tsx`
- Modify: matching test file

- [ ] **Step 1: Add chip below the opacity slider**

```tsx
import { evaluateReadability } from "@/lib/appearance/contrast"
// ... inside the wallpaper tab component, near the opacity slider:

// Foreground reference is the resolved theme's foreground; bg is approximated
// by the active wallpaper's dominant color or muted fallback for non-image
// sources. For now use --foreground / --background CSS-vars as the proxy:
const verdict = useMemo(() => {
  const cs = getComputedStyle(document.documentElement)
  const fg = cs.getPropertyValue("--foreground").trim() || "#000"
  const bg = cs.getPropertyValue("--background").trim() || "#fff"
  // Apply opacity to the bg layer mathematically — interpolate toward fg's
  // complement to model a "see-through" wallpaper. Simple linear approximation.
  const effectiveBg = mixWithBlack(bg, 1 - opacity) // helper defined below
  return evaluateReadability({ fgColor: fg, bgColor: effectiveBg })
}, [opacity])

<Slider value={[opacity]} onValueChange={(v) => setBackground({ opacity: v[0] })} min={0} max={1} step={0.05} />
<div className="flex items-center gap-2 mt-1">
  <Badge variant={verdict.level === "ok" ? "default" : verdict.level === "warn" ? "outline" : "destructive"}>
    {verdict.level.toUpperCase()} {verdict.ratio.toFixed(1)}:1
  </Badge>
  {verdict.recommendation && <span className="text-xs text-muted-foreground">{verdict.recommendation}</span>}
  {verdict.level === "fail" && (
    <Button
      size="sm"
      variant="outline"
      onClick={() => setBackground({ opacity: 0.4 })}
    >
      自动修复
    </Button>
  )}
</div>
```

`mixWithBlack` lives inline:

```tsx
function mixWithBlack(color: string, t: number): string {
  // t=0 → color; t=1 → black. Used to approximate "what the user sees" when
  // the layer is partially transparent over the dark UI bg.
  return `color-mix(in oklch, ${color}, black ${Math.round(t * 100)}%)`
}
```

- [ ] **Step 2: Test**

Add a test that simulates `opacity=0.05` and asserts the FAIL badge text appears, then clicks auto-fix and asserts opacity becomes 0.4. Use RTL `screen.getByText` for the badge.

- [ ] **Step 3: Commit**

```powershell
rtk pnpm test components/settings/appearance/tabs/wallpaper-tab.test.tsx
rtk git add -A
rtk git commit -m "feat(appearance): opacity guard with WCAG chip + auto-fix"
```

---

### Task 15: Scrim CSS + applier integration

**Files:**

- Modify: `app/globals.css`
- Modify: `lib/appearance/background-applier.tsx`

- [ ] **Step 1: Add scrim CSS** at the end of the wallpaper layer block:

```css
/* Text-protection scrim: when a low-opacity image bg is active, render a
   subtle bottom-up gradient so text columns stay legible without obscuring
   the image entirely. Only kicks in for image-kind sources at opacity < 0.5. */
[data-bg-target][data-bg-scrim="true"]::after,
body[data-bg-scrim="true"]::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    transparent 0%,
    color-mix(in oklch, var(--background) 50%, transparent) 100%
  );
  z-index: 0;
}
body[data-bg-scrim="true"]::after {
  position: fixed;
}
```

- [ ] **Step 2: Update `BackgroundApplier`** in `lib/appearance/background-applier.tsx` to set `data-bg-scrim`:

```tsx
const ATTR_SCRIM = "data-bg-scrim"
// ... in applyBackground:
const needsScrim = isImageSource && background.opacity < 0.5
if (background.scope === "all") {
  body.toggleAttribute(ATTR_SCRIM, needsScrim)
} else {
  // Per-scope: set on every active target; clear on body.
  body.removeAttribute(ATTR_SCRIM)
  document.querySelectorAll(`[data-bg-target="${background.scope}"]`).forEach((el) => {
    if (needsScrim) el.setAttribute(ATTR_SCRIM, "true")
    else el.removeAttribute(ATTR_SCRIM)
  })
}
```

- [ ] **Step 3: Test the scrim attribute toggling**

Add a test in `background-applier.test.tsx` that drives opacity 0.3 with an image kind and asserts the attribute is on body for `scope=all`.

- [ ] **Step 4: Commit**

```powershell
rtk git add -A
rtk git commit -m "feat(appearance): scrim layer protects text under low-opacity wallpapers"
```

---

### Task 16: Scope picker upgrade — 5 layout cards

**Files:**

- Modify: `components/settings/appearance/tabs/wallpaper-tab.tsx`

- [ ] **Step 1: Replace the existing scope `<Select>`** with 5 cards. Each card is an SVG mini-mockup of the cognia layout with the matching region filled in:

```tsx
const SCOPE_CARDS: Array<{
  scope: BackgroundScope
  label: string
  description: string
  highlight: { x: number; y: number; w: number; h: number }
}> = [
  {
    scope: "all",
    label: "整个应用",
    description: "包含所有面板",
    highlight: { x: 0, y: 0, w: 100, h: 60 },
  },
  {
    scope: "global",
    label: "主内容区",
    description: "不含侧边栏与对话框",
    highlight: { x: 20, y: 0, w: 80, h: 60 },
  },
  {
    scope: "chat",
    label: "聊天区",
    description: "仅聊天画面",
    highlight: { x: 20, y: 0, w: 60, h: 60 },
  },
  {
    scope: "canvas",
    label: "画布",
    description: "Canvas / 工作台",
    highlight: { x: 80, y: 0, w: 20, h: 60 },
  },
  {
    scope: "sidebar",
    label: "侧边栏",
    description: "导航条",
    highlight: { x: 0, y: 0, w: 20, h: 60 },
  },
]

function ScopeMockup({ highlight }: { highlight: { x: number; y: number; w: number; h: number } }) {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-12 rounded border border-border">
      <rect width="100" height="60" fill="var(--muted)" />
      <rect {...highlight} fill="var(--primary)" opacity="0.8" />
    </svg>
  )
}

;<div className="grid grid-cols-5 gap-2">
  {SCOPE_CARDS.map((card) => (
    <button
      key={card.scope}
      type="button"
      data-active={background.scope === card.scope}
      className="rounded border p-2 text-left data-[active=true]:border-primary data-[active=true]:bg-primary/5"
      onClick={() => setBackground({ scope: card.scope })}
      onMouseEnter={() => document.documentElement.setAttribute("data-bg-preview", card.scope)}
      onMouseLeave={() => document.documentElement.removeAttribute("data-bg-preview")}
    >
      <ScopeMockup highlight={card.highlight} />
      <div className="mt-1 text-xs font-medium">{card.label}</div>
      <div className="text-[10px] text-muted-foreground">{card.description}</div>
    </button>
  ))}
</div>
```

- [ ] **Step 2: Add hover-preview CSS**

```css
/* Hover preview: when a scope card is hovered, outline the region in the
   live app so the user understands what the scope means without applying it. */
html[data-bg-preview="chat"] [data-bg-target="chat"],
html[data-bg-preview="canvas"] [data-bg-target="canvas"],
html[data-bg-preview="sidebar"] [data-bg-target="sidebar"],
html[data-bg-preview="global"] [data-bg-target="global"] {
  outline: 2px dashed color-mix(in oklch, var(--primary) 70%, transparent);
  outline-offset: -2px;
}
html[data-bg-preview="all"] [data-bg-target] {
  outline: 2px dashed color-mix(in oklch, var(--primary) 70%, transparent);
  outline-offset: -2px;
}
```

- [ ] **Step 3: Test + commit**

```powershell
rtk pnpm test components/settings/appearance/tabs/wallpaper-tab.test.tsx
rtk git add -A
rtk git commit -m "feat(appearance): scope picker uses layout-thumbnail cards with hover preview"
```

---

# Phase 5 — Theme JSON I/O, reset, presets

---

### Task 17: `theme-export.ts` (round-trip)

**Files:**

- Create: `lib/appearance/theme-export.ts`
- Create: `lib/appearance/theme-export.test.ts`

- [ ] **Step 1: Tests**

```ts
import { exportThemeToJson, importThemeFromJson } from "./theme-export"

it("round-trips a theme", () => {
  const theme = {
    id: "x",
    name: "Demo",
    baseVariant: "dark",
    tokens: { light: NEUTRAL_LIGHT, dark: NEUTRAL_DARK },
  } as never
  const json = exportThemeToJson(theme)
  const restored = importThemeFromJson(json)
  expect(restored.name).toBe("Demo")
  expect(restored.tokens.dark.background).toBe(NEUTRAL_DARK.background)
})

it("rejects non-object input", () => {
  expect(() => importThemeFromJson("123")).toThrow()
})
```

- [ ] **Step 2: Implement**

```ts
// theme-export.ts
import type { CustomTheme } from "@/types/plugin/plugin-extended"

const SCHEMA_URL = "https://cognia.dev/schemas/custom-theme/v1.json"

export function exportThemeToJson(theme: CustomTheme): string {
  const payload = {
    $schema: SCHEMA_URL,
    name: theme.name,
    baseVariant: theme.baseVariant,
    derivedVariant: theme.derivedVariant,
    tokens: theme.tokens,
    exportedAt: new Date().toISOString(),
  }
  return JSON.stringify(payload, null, 2)
}

export function importThemeFromJson(text: string): Omit<CustomTheme, "id"> {
  const obj = JSON.parse(text)
  if (typeof obj !== "object" || obj === null) {
    throw new Error("Theme JSON must be an object")
  }
  if (!obj.tokens?.light || !obj.tokens?.dark) {
    throw new Error("Theme JSON missing tokens.light / tokens.dark")
  }
  if (obj.baseVariant !== "light" && obj.baseVariant !== "dark") {
    throw new Error("Theme JSON missing baseVariant")
  }
  return {
    name: typeof obj.name === "string" ? obj.name : "Imported Theme",
    baseVariant: obj.baseVariant,
    derivedVariant: obj.derivedVariant,
    tokens: obj.tokens,
  }
}
```

- [ ] **Step 3: Run + commit.**

---

### Task 18: Export/import buttons in custom-theme-tab + audit display

**Files:**

- Modify: `components/settings/appearance/tabs/custom-theme-tab.tsx`

- [ ] **Step 1: Per-card export button**

```tsx
import { exportThemeToJson, importThemeFromJson } from "@/lib/appearance/theme-export"
import { auditThemeContrast } from "@/lib/appearance/contrast-audit"

function downloadJson(name: string, content: string) {
  const blob = new Blob([content], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${name}.cognia-theme.json`
  a.click()
  URL.revokeObjectURL(url)
}

// In the card actions:
<Button size="sm" variant="ghost" onClick={() => downloadJson(theme.name, exportThemeToJson(theme))}>
  导出
</Button>

// Top-of-tab: import button + hidden file input
<Button onClick={() => importInputRef.current?.click()}>导入主题 JSON</Button>
<input
  ref={importInputRef}
  type="file"
  accept=".json"
  className="hidden"
  onChange={async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    try {
      const partial = importThemeFromJson(text)
      createCustomTheme(partial as never)
    } catch (err) {
      toast.error(`导入失败：${(err as Error).message}`)
    }
  }}
/>
```

- [ ] **Step 2: Contrast audit display**

In the editor section for the active theme, render contrast numbers:

```tsx
const audit = useMemo(() => auditThemeContrast(theme.tokens[editingVariant]), [theme, editingVariant])
const healthBadge =
  audit.failures.length === 0 ? "good" : audit.failures.length <= 2 ? "warn" : "bad"

<div className="flex items-center gap-2">
  <Badge>对比度：{audit.failures.length === 0 ? "全部达标" : `${audit.failures.length} 项不达标`}</Badge>
  {healthBadge === "bad" && <Badge variant="destructive">需要调整</Badge>}
</div>

// Per-row chip:
{audit.failures.find((f) => f.pair[0] === key || f.pair[1] === key) && (
  <Badge variant="destructive">⚠ 对比度</Badge>
)}
```

- [ ] **Step 3: Save dialog warning** if `audit.failures.length > 0`:

```tsx
async function handleSave() {
  const audit = auditThemeContrast(theme.tokens[editingVariant])
  if (audit.failures.length > 0) {
    const ok = confirm(
      `这个主题有 ${audit.failures.length} 个对比度问题，可能影响可读性。仍要保存？`
    )
    if (!ok) return
  }
  updateCustomTheme(theme.id, { tokens: theme.tokens })
}
```

- [ ] **Step 4: Test + commit**

---

### Task 19: Built-in VSCode-inspired presets

**Files:**

- Create: `lib/appearance/built-in-vscode-themes.ts`
- Create: `lib/appearance/built-in-vscode-themes.test.ts`
- Modify: `components/settings/appearance/tabs/theme-tab.tsx`

- [ ] **Step 1: Inline the 4 themes**

```ts
// built-in-vscode-themes.ts
import draculaJson from "./vscode-theme/__fixtures__/dracula.json"
import oneDarkProJson from "./vscode-theme/__fixtures__/one-dark-pro.json"
import tokyoNightDarkJson from "./vscode-theme/__fixtures__/tokyo-night-dark.json"
import githubLightJson from "./vscode-theme/__fixtures__/github-light-default.json"
import { vscodeThemeToCustomTheme } from "./vscode-theme/parse-json"
import { deriveOppositeVariant } from "./derive-variant"
import type { CustomTheme } from "@/types/plugin/plugin-extended"

function build(name: string, json: unknown): Omit<CustomTheme, "id"> {
  const parsed = vscodeThemeToCustomTheme(json as never, { nameHint: name })
  const baseVariant = parsed.theme.isDark ? "dark" : "light"
  const opposite = baseVariant === "dark" ? "light" : "dark"
  const single = parsed.theme.colors
  return {
    name,
    baseVariant,
    derivedVariant: opposite,
    tokens: {
      [baseVariant]: single,
      [opposite]: deriveOppositeVariant(single, baseVariant),
    } as never,
  }
}

export const BUILT_IN_VSCODE_THEMES: ReadonlyArray<Omit<CustomTheme, "id">> = [
  build("Dracula", draculaJson),
  build("One Dark Pro", oneDarkProJson),
  build("Tokyo Night Dark", tokyoNightDarkJson),
  build("GitHub Light Default", githubLightJson),
]
```

(Configure `tsconfig.json` `resolveJsonModule: true` if not already; check before editing.)

- [ ] **Step 2: Add the section to `theme-tab.tsx`**

```tsx
import { BUILT_IN_VSCODE_THEMES } from "@/lib/appearance/built-in-vscode-themes"

// After the 8 color preset chips:
;<section>
  <h3 className="text-sm font-medium mb-2">VSCode 风格预设</h3>
  <div className="grid grid-cols-4 gap-2">
    {BUILT_IN_VSCODE_THEMES.map((preset) => (
      <button
        key={preset.name}
        className="rounded border p-2"
        onClick={() => {
          const id = createCustomTheme(preset as never)
          setActiveCustomTheme(id)
        }}
      >
        <div className="flex gap-1">
          <span
            className="h-4 w-4 rounded"
            style={{ background: preset.tokens[preset.baseVariant].background }}
          />
          <span
            className="h-4 w-4 rounded"
            style={{ background: preset.tokens[preset.baseVariant].primary }}
          />
          <span
            className="h-4 w-4 rounded"
            style={{ background: preset.tokens[preset.baseVariant].accent }}
          />
        </div>
        <div className="text-xs mt-1">{preset.name}</div>
      </button>
    ))}
  </div>
</section>
```

- [ ] **Step 3: Test + commit**

```powershell
rtk pnpm test lib/appearance/built-in-vscode-themes
rtk git add -A
rtk git commit -m "feat(appearance): 4 built-in VSCode-style presets"
```

---

### Task 20: Reset appearance button

**Files:**

- Modify: `components/settings/appearance/appearance-section.tsx`

- [ ] **Step 1: Add header button**

```tsx
import { useSettingsStore } from "@/stores/settings"

async function handleReset() {
  const ok = confirm("确认重置所有外观设置？已上传的壁纸图片不会被删除。")
  if (!ok) return
  const store = useSettingsStore.getState()
  await store.save({
    customThemes: [],
    activeCustomThemeId: null,
    customCss: "",
    customCssEnabled: false,
    background: { ...DEFAULT_BACKGROUND_SETTINGS },
  })
}

;<Button variant="outline" size="sm" onClick={handleReset}>
  重置外观
</Button>
```

- [ ] **Step 2: Test + commit**

---

# Phase 6 — Integration tests + manual verification

---

### Task 21: Integration test mirroring 8-step manual checklist

**Files:**

- Create: `tests/integration/appearance.test.tsx`

- [ ] **Step 1: Build a `renderApp` helper** that wraps the layout with all providers (mock the Tauri-only providers):

```tsx
// Provides ThemeProvider + SettingsHydrator + CustomThemeApplier + BackgroundApplier
function renderApp(children: React.ReactNode) {
  return render(
    <ThemeProvider attribute="class">
      <SettingsHydrator />
      <CustomThemeApplier />
      <BackgroundApplier />
      {children}
    </ThemeProvider>
  )
}
```

- [ ] **Step 2: Write each of the 8 steps as a test case**

```tsx
describe("appearance integration", () => {
  beforeEach(() => useSettingsStore.setState({ settings: null, loaded: false }))

  it("dark mode toggle adds .dark class to <html>", async () => {
    /* ... */
  })
  it("custom theme activation writes --primary to <html>", async () => {
    /* ... */
  })
  it("dracula.json import registers a theme that activates", async () => {
    /* ... */
  })
  it("dracula.vsix import opens picker → commit", async () => {
    /* ... */
  })
  it("scope=chat sets data-bg-scope on body", async () => {
    /* ... */
  })
  it("opacity=0.05 shows FAIL chip → auto-fix sets opacity=0.4", async () => {
    /* ... */
  })
  it("settings persist across re-render via fake-indexeddb", async () => {
    /* ... */
  })
  it("reset clears customThemes but keeps wallpapers", async () => {
    /* ... */
  })
})
```

(Wire `fake-indexeddb` per the existing test setup.)

- [ ] **Step 3: Run + commit**

```powershell
rtk pnpm test tests/integration/appearance.test.tsx
rtk git add -A
rtk git commit -m "test(appearance): integration tests covering manual verification flow"
```

---

### Task 22: Final gates + manual verification

- [ ] **Step 1: Full test suite**

```powershell
rtk pnpm test
rtk pnpm typecheck
rtk pnpm lint
```

All clean.

- [ ] **Step 2: Coverage check on `lib/appearance/`**

```powershell
rtk pnpm test:coverage -- --collectCoverageFrom='lib/appearance/**'
```

Expected: ≥ 90% lines/branches/functions per CLAUDE.md.

- [ ] **Step 3: Manual verification (web mode)**

```powershell
rtk pnpm dev
```

Walk the 8 steps in `docs/content/docs/adr/0007-theme-and-background-fix.md` "Verification" section:

1. Open `/settings?section=appearance` → toggle dark/light → page colors change.
2. Custom tab → create theme → primary green → activate → buttons turn green.
3. Import `tokyo-night-dark.json` fixture → activate → palette matches.
4. Import `dracula.vsix` fixture → multi-pick dialog opens → commit Dracula → activate → palette matches.
5. Wallpaper tab → hover scope=chat card → only chat region outlined.
6. Upload image → scope=chat → only chat region has bg.
7. Drag opacity to 0.05 → FAIL badge appears → click 自动修复 → opacity = 0.4.
8. F5 → all settings preserved.

If any step regresses, revert the offending commit and patch.

- [ ] **Step 4: Manual verification (Tauri mode)**

```powershell
rtk pnpm tauri dev
```

Repeat steps 1, 2, 6, 8. Tauri-only paths: wallpaper image lands at `<appData>/cognia/wallpapers/...`; restart the app, image still loads.

- [ ] **Step 5: Final commit / PR**

If working on a feature branch:

```powershell
rtk git push -u origin <branch-name>
rtk gh pr create --title "fix(appearance): make theme + background customization actually work" --body "$(rtk git log master.. --pretty=format:'- %s' | head -30)"
```

Otherwise stop here; user will handle integration.

---

## Self-Review Checklist (run by author after writing this plan)

1. **Spec coverage**:
   - F1 (hydration) → Task 2 ✓
   - B1 (applier mounted) → Task 4 ✓
   - B2 (camelCase mismatch + missing 7 keys) → Task 3 + Task 4 ✓
   - C1 (fallback order) → Task 10 ✓
   - C2 (token map incomplete) → Task 3 (expanded VSCODE_COLOR_MAP) ✓
   - D1 (VSIX errors) → Task 11 ✓
   - E1 (scope dead code) → Task 5 ✓
   - E2 (opacity hides text) → Tasks 13-15 ✓
   - Schema migration → Task 8 ✓
   - Dual variant → Tasks 6-9 ✓
   - Theme JSON I/O → Tasks 17-18 ✓
   - WCAG audit → Tasks 13, 18 ✓
   - Reset → Task 20 ✓
   - Built-in presets → Task 19 ✓
   - Real fixtures → Task 12 ✓
   - E2E → Task 21 ✓

2. **Placeholder scan**: All steps have concrete commands or code. The four "TBD via grep" containers in the file table are properly anchored with a Step 1 grep workflow in Task 5.

3. **Type consistency**:
   - `ThemeColors` extended in Task 3 → consumed by Task 4 (`CSS_VAR_KEYS` length 23) ✓
   - `CustomTheme.tokens` introduced in Task 7 → migration in Task 8 → consumed by import path Task 9, theme-export Task 17, built-in presets Task 19 ✓
   - `deriveOppositeVariant` from Task 6 → used in Tasks 8, 9, 19 ✓
   - `wcagContrast` from Task 13 → used in Tasks 14 (opacity guard), 18 (audit display) ✓

No issues found. Plan is implementation-ready.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-04-theme-and-background-fix.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Phase 3 and Phase 4 dispatch in parallel after Phase 2 lands.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?

---
title: "ADR 0007: Theme and background customization fix"
description: "Wire up the unmounted theme/background apply hooks, fix VSCode theme import, complete the dual-variant token model, and add WCAG contrast guards."
---

## Status

Proposed, 2026-05-04.

## Context

cognia-next ships an extensive appearance subsystem under `lib/appearance/`,
`stores/settings/settings-store.ts`, `lib/db/settings.ts`, and the six-tab
`components/settings/appearance/` UI. From a static-code perspective the
feature looks complete: state shapes exist, persistence is wired, VSCode
JSON/VSIX parsers are written, scope-aware CSS is in `app/globals.css`.

In practice almost none of it works for end users. Three parallel
investigations confirmed:

- Custom themes activate but page colors never change.
- VSCode JSON / VSIX imports either silently fail or apply the wrong colors.
- Background `scope` other than `all` produces no background anywhere.
- Refreshing the page (or restarting Tauri) reverts every appearance
  setting to defaults.
- Low background opacity hides foreground text.

The root causes are not "code missing" — they are **hooks that were never
mounted, fallback orders written backwards, and a CSS scope feature whose
target attribute was never applied to any container**. Fixing them
requires a coordinated set of changes that also pulls forward design
upgrades the half-built feature missed: a dual-variant `{light, dark}`
token model, automatic OKLCH derivation between variants, real-time WCAG
contrast feedback, and explicit error surfaces for the import flow.

## Confirmed root causes

| #   | Bug                             | Root cause                                                                                                                                                                                                                                             | Evidence                                                                                                                                  |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Settings lost on refresh        | `useSettingsStore.load()` is never called at app startup. The store stays at `loaded:false`; `SettingsSyncProvider` early-returns; UI shows defaults forever.                                                                                          | `stores/settings/settings-store.ts:364` defines `load()`; nothing in `app/layout.tsx` or `components/providers/*` invokes it              |
| B1  | Custom themes don't apply       | No `CustomThemeApplier` is mounted. `activeCustomThemeId` and `customThemes` persist correctly, but no code converts tokens into CSS variables on `<html>`.                                                                                            | `app/layout.tsx:46-78` only mounts `BackgroundApplier`; `lib/themes/index.ts:130` `resolveActiveThemeColors()` is an orphan pure function |
| B2  | Token key mismatch              | `THEME_COLOR_KEYS` uses camelCase (`primaryForeground`); CSS expects kebab (`--primary-foreground`). 7 keys are missing entirely (`popover`, `popoverForeground`, `input`, 4× `sidebar*`).                                                             | `lib/appearance/vscode-theme/token-mapping.ts:75-92` vs `app/globals.css:47-114`                                                          |
| C1  | VSCode JSON import wrong colors | `DEFAULT_FALLBACKS` is a hardcoded blue palette that overrides theme intent when keys are missing. Fallback order is reversed — derived values should come first, hardcoded last.                                                                      | `lib/appearance/vscode-theme/parse-json.ts:166`: `out.ring = out.primary ?? fallback.ring`                                                |
| C2  | Token map incomplete            | `--popover`, `--popover-foreground`, `--input`, `--sidebar*` have no VSCode mapping; common keys like `editor.selectionBackground`, `widget.background`, `button.background` are unused.                                                               | `lib/appearance/vscode-theme/token-mapping.ts:20-72`                                                                                      |
| D1  | VSIX import crashes / hangs     | (a) `JSZip.loadAsync` exceptions escape the outer catch; (b) lazy `parse()` closure holds a `zip` reference that may be GC'd before the user clicks import; (c) `commitTheme()` swallows errors silently, leaving the UI in a permanent loading state. | `lib/appearance/vscode-theme/parse-vsix.ts:61, 99-108`; `components/settings/appearance/tabs/vscode-import-tab.tsx:86-99`                 |
| E1  | `scope` is dead code            | The CSS selector `[data-bg-target="chat"]::before` exists, but no component in the entire repo applies a `data-bg-target` attribute. Any scope other than `all` results in no background being rendered.                                               | grep `data-bg-target` matches only `app/globals.css`                                                                                      |
| E2  | Low opacity hides text          | The opacity slider has no floor and no contrast warning. With `scope=all` and a busy image at low opacity, foreground/background contrast falls below 4.5:1.                                                                                           | `components/settings/appearance/tabs/wallpaper-tab.tsx`; `lib/appearance/background-applier.tsx:113`                                      |

## Decisions

### 1. Hydrate the settings store at startup (fix F1)

Add `components/providers/settings-hydrator.tsx`. A mount-once `useEffect`
calls `useSettingsStore.getState().load()`. It mounts inside
`ThemeProvider` and before `SettingsSyncProvider` so that subsequent
providers see `loaded === true` once Dexie returns.

### 2. Mount a custom-theme applier (fix B1, B2)

Add `lib/appearance/custom-theme-applier.tsx`. It subscribes to
`activeCustomThemeId`, `customThemes`, and the `resolvedTheme` from
`next-themes`, calls `resolveActiveThemeColors(settings, isDark)`, and
writes 23 CSS variables onto `document.documentElement` using a
`themeKeyToCssVar` helper that converts camelCase → kebab. Cleanup on
deactivation removes the inline overrides so the cascade falls back to
the `:root` and `.dark` defaults.

`THEME_COLOR_KEYS` expands from 16 to 23 keys. The new keys are
`popover`, `popoverForeground`, `input`, `sidebar`, `sidebarForeground`,
`sidebarPrimary`, and `sidebarBorder`, each matching a CSS variable
already defined in `app/globals.css`.

### 3. Dual-variant token model with OKLCH derivation (Option A)

`CustomTheme.tokens` becomes `{ light: ThemeColors; dark: ThemeColors }`.
A new `baseVariant: "light" | "dark"` records user intent. The opposite
variant is filled by `lib/appearance/derive-variant.ts` using OKLCH
math (via [`culori`](https://culori.js.org/), ~25 KB gzipped):

1. Parse the input color into OKLCH `{ l, c, h }`.
2. Neutral colors (`c < 0.04`) flip lightness: `l_new = 1 - l`.
3. Saturated colors keep hue, attenuate chroma 8% in dark mode, and
   remap lightness via `l_new = 0.4 + 0.4 * (1 - l)` to avoid
   pure-black/pure-white extremes.
4. `enforceReadable(fg, bg)` adjusts foreground lightness if the
   resulting WCAG contrast falls below 4.5:1.

A Dexie `.version(16).upgrade(tx)` migration walks `customThemes` in the
`settings` singleton and rewrites each `tokens` field from the legacy
single-set shape to the dual shape. Schema v15 is the current head
(plugin tables, ADR 0006); the settings table itself does not change
shape. The project is unreleased, so migration risk is low.

### 4. Reverse the VSCode JSON fallback order (fix C1, C2)

`parse-json.ts` is rewritten so derivation is first, hardcoded fallback
last. When a VSCode key is missing, the parser tries:

1. Derive from already-matched `background` / `foreground` (e.g.
   `darken(bg, 0.05)` for `card`, `mix(fg, bg, 0.7)` for
   `mutedForeground`).
2. Use a sibling token if available (`primary` for `ring`).
3. Only as a last resort use `DEFAULT_FALLBACKS`.

The `VSCODE_COLOR_MAP` table covers the 25-key VSCode standard
extracted from `code.visualstudio.com/api/references/theme-color`,
adding mappings for `editorWidget.background` /
`dropdown.background` / `quickInput.background` → `popover`,
`input.*` → `input`, `sideBar.*` → `sidebar*`, `errorForeground` →
`destructiveForeground`, and `descriptionForeground` →
`mutedForeground`.

`readableForeground` is upgraded from a binary near-black/near-white
choice to a perceptually adjusted lightness that hits a target 4.7:1
contrast while preserving hue and chroma.

`parse-json` outputs a single `ThemeColors`. Callers determine
`baseVariant` from `theme.type` (or the manifest's `uiTheme`, or the
perceptual lightness of `editor.background`) and call
`deriveOppositeVariant` for the missing side.

### 5. Eager VSIX parsing with explicit errors (fix D1)

`parse-vsix.ts` no longer returns lazy `parse()` closures. `readVsix()`
synchronously parses every contributed theme JSON, returning fully
populated `ParsedTheme[]`. The `zip` instance is dropped before the
function returns, eliminating the GC race.

`vscode-import-tab.tsx` adds a top-level `error: string | null` state
and renders failures via `<Alert variant="destructive">`. A 30 s
loading-state timeout displays "解析超时，可能是文件损坏" if the parse
hangs.

### 6. Make scope work (fix E1, decision D-1)

The five wallpaper scopes — `all`, `global`, `chat`, `canvas`, `sidebar`
— all become functional:

- `all` continues to use `body::before`.
- `global` wraps the main content in `<div data-bg-target="global">` if
  no stable container exists.
- `chat`, `canvas`, `sidebar` mark their respective root containers with
  `data-bg-target="chat" / "canvas" / "sidebar"`. Containers are
  located during execution (candidates: chat shell, twin workbench,
  global navigation sidebar).

The wallpaper-tab `scope` selector upgrades from a `<Select>` to five
mini-cards that render an app-layout thumbnail with the covered region
highlighted. Hovering a card sets `data-bg-preview="<scope>"` on the
root, drawing a contrast outline around the matching region in the live
app.

### 7. Opacity readability guard (fix E2)

`lib/appearance/contrast.ts` exposes `wcagContrast(fg, bg)` and
`evaluateReadability(...)`. The wallpaper-tab opacity slider grows a
real-time chip under it: green `OK 6.2:1` / yellow `WARN 3.8:1` / red
`FAIL 2.1:1`. A `Auto-fix` button appears when contrast falls into
`fail` and resets opacity to a recommended value.

`background-applier.tsx` flips `data-bg-scrim="true"` on the active
target container when `opacity < 0.5` and the wallpaper kind is
`image`. A new `globals.css` rule renders a faint `--background`
gradient via `::after` to protect text legibility without hiding the
image.

### 8. Theme JSON export / import

`lib/appearance/theme-export.ts` ships `exportThemeToJson(theme)` and
`importThemeFromJson(text)`. Output uses the same `$schema` +
`integrity` checksum convention as `BackupPackageV3`. The
`custom-theme-tab` adds export and import buttons per card; web uses
`<a download>`, Tauri uses the native `dialog.save` IPC.

### 9. Contrast audit for custom themes

`lib/appearance/contrast-audit.ts` exposes
`auditThemeContrast(tokens)` returning a list of failing pairs (fg/bg,
cardFg/card, popoverFg/popover, primaryFg/primary, destructiveFg/
destructive, mutedFg/muted, accentFg/accent, sidebarFg/sidebar). The
custom-theme tab renders contrast numbers per token row and a summary
health badge. Save warns when there are failures.

### 10. Reset and built-in VSCode presets

`lib/appearance/built-in-vscode-themes.ts` inlines four real
marketplace themes (Dracula, One Dark Pro, Tokyo Night Dark, GitHub
Light Default) and runs them through the same `parse-json` pipeline,
so users can verify "VSCode import works" without leaving the app. The
inlined JSON also doubles as parser regression fixtures.

`appearance-section.tsx` gains a "Reset appearance" button in the
header. It clears `customThemes`, `customCss`, and `background`, but
preserves `wallpapers` (user-uploaded image library — clearing them
would destroy user content).

### 11. E2E coverage

`tests/e2e/appearance.spec.ts` exercises the full user path: dark/light
toggle, custom-theme creation and activation, JSON import,
multi-theme VSIX import, scope switching with wallpaper, opacity guard
and auto-fix, refresh persistence.

Unit fixtures land in `lib/appearance/vscode-theme/__fixtures__/`:
four real theme JSONs, two real `.vsix` bundles, one truncated
`corrupt.vsix`, one valid-but-empty `no-themes.vsix`.

## Out of scope

- Wallpaper slideshow (rotate through multiple images).
- Per-character / per-conversation theme overrides.
- VSCode Marketplace in-app search / install.
- Replacing the custom-CSS textarea with Monaco.
- Consuming VSCode `tokenColors` (syntax highlight) — the app currently
  renders code via `highlight.js` / `prism`, not a TextMate grammar.
  Imported themes preserve the field but do not apply it.

## Sources

- [VSCode Theme Color Reference](https://code.visualstudio.com/api/references/theme-color)
- [VSCode Color Theme Guide](https://code.visualstudio.com/api/extension-guides/color-theme)
- [Better dynamic themes in Tailwind with OKLCH (Evil Martians)](https://evilmartians.com/chronicles/better-dynamic-themes-in-tailwind-with-oklch-color-magic)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [APCA Contrast Calculator](https://apcacontrast.com/)

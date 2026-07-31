# CLI TUI Theme System — implementation plan

Goal: add a full semantic-token theme layer to the CLI TUI (Ink), mimicking Claude
Code & Codex, and **reuse the user's existing Claude Code theme** (explicit
`theme: "claude-code"`) and **reuse the user's Codex code-block highlight theme**.

## Decisions (confirmed with user 2026-06-12)

- **Scope**: full semantic-token layer — migrate ~30 components off hardcoded ANSI
  color names onto `useTheme()` tokens. Not a footer-only patch.
- **Codex**: reuse ONLY the code-block syntax-highlight theme name
  (`~/.codex/config.toml` → `[tui].theme`), mapped to a highlight.js theme. Codex
  has no reusable semantic UI palette (issue #21130 open).
- **Reuse trigger**: explicit `theme: "claude-code"` (opt-in), mirroring the
  precedent of `externalSkills` but NOT default-on for theme.

## Research facts (verified)

- Claude Code: `~/.claude/settings.json` → `theme` (string). Built-ins: `auto`,
  `dark`, `light`, `dark-daltonized`, `light-daltonized`, `dark-ansi`, `light-ansi`.
  Custom: `~/.claude/themes/<slug>.json` `{name?, base?: built-in, overrides?: token→color}`;
  stored value `custom:<slug>`. Colors: `#rrggbb` / `#rgb` / `rgb()` / `ansi256(n)`
  / `ansi:<name>`. Brand `claude` = `#D77757`.
- Codex CLI: `~/.codex/config.toml` → `[tui].theme` (kebab string). 32 bundled
  syntect/bat .tmTheme names; only syntax highlighting + diffs.
- **Ink `<Text color>` supports hex/rgb** (chalk under the hood, downsampled to
  terminal capability) — so reusing Claude's hex themes is feasible.

## Current state

- Only `VIVID` palette in `tui/format/status-bar.ts` (footer only).
  `STATUS_THEMES = default/dim/vivid/mono` (`config/schema.ts:53`) = footer only.
- ~30 components hardcode ANSI names (cyan/green/red/yellow/magenta/blue/gray).
- Code highlight delegated to `cli-highlight` (highlight.js) default theme.
- Mascot colors: `tui/mascot/mascot.ts` COLOR map.

## Architecture

`cli/src/tui/theme/`

- `palette.ts` — `ThemePalette` (semantic tokens) + `BaseColors` (~8) +
  `expandPalette(base, overrides?)` deriving every token from base. + test
- `builtins.ts` — `BUILTIN_THEMES`: classic (= current ANSI, DEFAULT, zero change),
  dark, light, dark-daltonized, light-daltonized, mono. `getBuiltinTheme(name)`. + test
- `claude-code.ts` — `readClaudeCodeTheme({osHome, read})`: settings.json theme →
  base built-in + custom themes/<slug>.json overrides → token map → ThemePalette. + test
- `codex.ts` — `readCodexHighlightTheme({osHome, read})`: parse config.toml
  `[tui].theme` (tiny regex, no TOML dep) → highlight.js theme hint. + test
- `resolve.ts` — `resolveTheme(config, {osHome, read})` → ThemePalette
  (built-in | "claude-code" | "custom:slug"; merges codex codeHighlight hint). + test
- `context.tsx` — `ThemeProvider` + `useTheme()`. Default = classic. + test

Config: `schema.ts` add `theme?: string` + `THEME_NAMES`; add "theme" to
SETTABLE_KEYS in `mutate.ts` (scalar). `load.ts` env `COGNIA_THEME`. Resolved
config carries `theme?`.

Wiring: `App.tsx` resolves palette via useMemo(resolveTheme) and wraps tree in
`<ThemeProvider>`. `SET_THEME` reducer + `theme` CommandEffect + `theme-command.ts`
(reuses `select` overlay, `onSelectCommand: "theme set"`) + register in registry.

Migration: status-bar.ts + Footer take palette; mascot.ts COLOR → palette;
Markdown/CellView/Inflight/Input/Banner/SelectList/SlashPalette/FileCompleter +
all overlays → useTheme; highlight.ts accepts codeHighlight hint.

## Verify

`pnpm --filter @cognia/agent-cli test` (or jest path), tsc 0, eslint 0, new modules ≥90% cov.
CLI has NO next-intl i18n (English strings, matches existing convention).

## Status — COMPLETE (2026-06-12)

- [x] foundation (palette/builtins/color/claude-code/codex/resolve/context)
- [x] config (schema theme field + COGNIA_THEME env + mutate SETTABLE_KEYS)
- [x] wiring (App ThemeProvider via useMemo(resolveTheme), reducer SET_THEME,
      `theme` CommandEffect, /theme command reusing select overlay, registry)
- [x] component migration (status-bar/highlight/Footer/Mascot/Markdown by hand;
      16 .tsx via 3 parallel subagents — disjoint files)
- [x] /theme appears in help auto (category "config")
- [x] verify: 1602 CLI tests pass, tsc 0, eslint clean, new-.ts cov 99.6/93.8/96.4/99.6

KEY INSIGHT: component tests render WITHOUT a ThemeProvider → useTheme() returns
classic, whose token values are the SAME ANSI strings as before, so the whole
migration preserved every existing data-color assertion (no test rewrites).

GOTCHA: `NODE_ENV=test` is REQUIRED on `npx jest` here — without it next/jest
falls back to babel-without-TS-preset and every suite fails to PARSE (inline
`type` imports). Not a real failure.

GOTCHA: highlight.ts ANSI_RE contains a raw ESC byte the Read tool renders
invisibly — preserved on disk; matches `\x1b[...m`.

NOT DONE: real-TTY smoke of /theme + live recolor; reading a REAL ~/.claude or
~/.codex (resolve short-circuits to classic when theme unset, so tests are
deterministic). Codex reuse maps name→curated code palette (5 known + fallback);
unknown names get a neutral dark code palette + the name surfaced.

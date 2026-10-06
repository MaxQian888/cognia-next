/**
 * Single source of truth for the Shiki syntax-highlighting theme pair used by
 * every code surface in the chat experience.
 *
 * Why this exists: code blocks are highlighted in several places —
 *   - streaming text, via Streamdown's `@streamdown/code` plugin
 *     (`components/ai-elements/streamdown-plugins.ts`)
 *   - finalized chat messages, via `components/chat/renderers/code-block.tsx`
 *   - tool-approval / blame surfaces, via `components/ai-elements/code-block.tsx`
 *
 * Before centralizing, Streamdown defaulted to `github-light`/`github-dark`
 * while the finalized renderer used `one-light`/`one-dark-pro`, so every code
 * block visibly *recolored* the instant a message finished streaming. Pointing
 * all of them at this constant keeps the colors identical across the streaming
 * → finalized transition and across the whole app, and lets the highlight
 * cache key off a single, stable theme id.
 *
 * Both themes are always emitted; the active one is selected by the `.dark`
 * class on `<html>`, so this tracks the global light/dark theme (manual toggle
 * or auto-mode) with no re-highlight on switch.
 */
import type { ChatCodeThemeId } from "@/types/appearance"

export const CHAT_CODE_THEME = {
  light: "one-light",
  dark: "one-dark-pro",
} as const

export type ChatCodeThemeLight = typeof CHAT_CODE_THEME.light
export type ChatCodeThemeDark = typeof CHAT_CODE_THEME.dark

/**
 * ADR-0218 — the curated light/dark pairs behind the `markdown.codeTheme`
 * setting. ADR-0127 kept the theme hard-coded because the streaming and
 * finalised renderers must agree; they still must, so the setting picks a PAIR
 * from this table and both branches read the same resolved entry. `one` is the
 * historical default and stays identical to {@link CHAT_CODE_THEME}.
 *
 * Every name is a Shiki bundled theme (pinned by `code-theme.test.ts`), so a
 * pair never needs a network fetch or a custom grammar load.
 */
export interface ChatCodeThemePair {
  light: string
  dark: string
}

export const CHAT_CODE_THEMES: Readonly<Record<ChatCodeThemeId, ChatCodeThemePair>> = {
  one: CHAT_CODE_THEME,
  github: { light: "github-light-default", dark: "github-dark-default" },
  vscode: { light: "light-plus", dark: "dark-plus" },
  vitesse: { light: "vitesse-light", dark: "vitesse-dark" },
  catppuccin: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
  "rose-pine": { light: "rose-pine-dawn", dark: "rose-pine-moon" },
  solarized: { light: "solarized-light", dark: "solarized-dark" },
  everforest: { light: "everforest-light", dark: "everforest-dark" },
  min: { light: "min-light", dark: "min-dark" },
}

/** Resolve a setting value to its pair; unknown ids fall back to the default. */
export function resolveChatCodeTheme(id: ChatCodeThemeId | undefined): ChatCodeThemePair {
  return (id && CHAT_CODE_THEMES[id]) || CHAT_CODE_THEME
}

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
export const CHAT_CODE_THEME = {
  light: "one-light",
  dark: "one-dark-pro",
} as const

export type ChatCodeThemeLight = typeof CHAT_CODE_THEME.light
export type ChatCodeThemeDark = typeof CHAT_CODE_THEME.dark

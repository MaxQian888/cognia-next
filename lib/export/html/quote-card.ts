// Message quote card: turns a single chat message (or a highlighted selection)
// into a self-contained, tweet-like shareable card — role glyph, quoted body,
// model + timestamp, themed chrome, optional wallpaper. Rendered as a static
// HTML string (no scripts) so it shares through the zero-knowledge pipeline as
// the `chat-quote` kind and rasterizes to PNG via html2canvas-pro. Mirrors the
// structure of `lib/usage/usage-card.ts`.

import { THEMES, type ThemeId, type ThemeTokens } from "./syntax-themes"
import { getStylePreset } from "./style-presets"
import { buildCardWallpaperCss } from "./theme-wallpaper"

export interface QuoteCardOptions {
  role: "user" | "assistant" | "system" | string
  /** Display name (persona / "You" / "Assistant"); falls back to a role label. */
  authorName?: string
  /** The quoted message text (a selection, or the whole message). */
  text: string
  model?: string
  timestamp: Date
  /** Conversation title, shown in the footer. */
  sessionTitle?: string
  /** Visual style; defaults to the flagship "arknights" look. */
  theme?: ThemeId
  customTheme?: ThemeTokens
  /** Inlined theme wallpaper data-URL backdrop (resolved by the caller). */
  wallpaperDataUrl?: string
}

const MONO_STACK = `"JetBrains Mono", "Cascadia Code", "SFMono-Regular", Consolas, "Noto Sans Mono", monospace`

/** Card markup + scoped `<style>`, embeddable in a document or the app DOM. */
export function renderQuoteCardFragment(options: QuoteCardOptions): string {
  const theme = options.theme ?? "arknights"
  const t = options.customTheme ?? THEMES[theme]
  const preset = getStylePreset(theme)
  const author = options.authorName || roleLabel(options.role)
  const sub = [options.model, options.timestamp.toLocaleString()].filter(Boolean).join(" · ")
  const banner = preset?.bannerText
    ? `<span class="qcard-banner">${escapeHtml(preset.bannerText)}</span>`
    : ""
  const footerTag = preset?.footerText ? `${escapeHtml(preset.footerText)} · ` : ""
  const title = options.sessionTitle
    ? `<span class="qcard-title">${escapeHtml(options.sessionTitle)}</span>`
    : "<span></span>"
  const body = linkify(inlineMarkdown(escapeHtml(options.text)))
  const wallpaperCss = options.wallpaperDataUrl
    ? buildCardWallpaperCss(options.wallpaperDataUrl, t)
    : ""

  return `<style>${cardStylesheet(t)}${presetOverrides(theme, t)}${wallpaperCss}</style>
<div class="qcard" data-theme="${escapeHtml(theme)}" data-role="${escapeHtml(options.role)}">
  <div class="qcard-head">
    <span class="qcard-avatar" aria-hidden="true">${escapeHtml(roleGlyph(options.role))}</span>
    <div class="qcard-meta">
      <span class="qcard-author">${escapeHtml(author)}</span>
      <span class="qcard-sub">${escapeHtml(sub)}</span>
    </div>
    ${banner}
  </div>
  <blockquote class="qcard-body">${body}</blockquote>
  <div class="qcard-foot">${title}<span class="qcard-brand">${footerTag}Shared via Cognia</span></div>
</div>`
}

/** Full self-contained HTML document for the share pipeline / iframe preview. */
export function buildQuoteCardHtml(options: QuoteCardOptions): string {
  const theme = options.theme ?? "arknights"
  const t = options.customTheme ?? THEMES[theme]
  const title = options.sessionTitle ?? "Cognia message card"
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>body { margin: 0; padding: 24px; background: ${t.bg}; display: flex; justify-content: center; }</style>
</head>
<body>
${renderQuoteCardFragment(options)}
</body>
</html>`
}

/**
 * Minimal, safe inline markdown for already-HTML-escaped text. Handles code
 * spans, bold and italic only — never parses raw HTML (input is pre-escaped),
 * so it cannot introduce script. Code spans are processed first so their
 * contents aren't further formatted.
 */
export function inlineMarkdown(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^_])__([^_\n]+)__/g, "$1<strong>$2</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
}

function linkify(html: string): string {
  return html.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    (m) => `<a href="${m}" target="_blank" rel="noreferrer">${m}</a>`
  )
}

function roleGlyph(role: string): string {
  switch (role) {
    case "user":
      return "👤"
    case "assistant":
      return "🤖"
    case "system":
      return "⚙️"
    default:
      return "💬"
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "You"
    case "assistant":
      return "Assistant"
    case "system":
      return "System"
    default:
      return role
  }
}

function cardStylesheet(t: ThemeTokens): string {
  return `
.qcard { box-sizing: border-box; width: 520px; max-width: 100%; padding: 22px; border: 1px solid ${t.border}; border-radius: 16px; background: ${t.bg}; color: ${t.text}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.qcard * { box-sizing: border-box; }
.qcard-head { display: flex; align-items: center; gap: 12px; }
.qcard-avatar { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 999px; background: ${t.surface}; border: 1px solid ${t.border}; font-size: 20px; flex: 0 0 auto; }
.qcard-meta { display: flex; flex-direction: column; min-width: 0; }
.qcard-author { font-weight: 700; font-size: 15px; color: ${t.accent}; overflow-wrap: anywhere; }
.qcard-sub { font-size: 12px; color: ${t.muted}; }
.qcard-banner { margin-left: auto; padding: 3px 10px; border-radius: 999px; background: ${t.surface}; border: 1px solid ${t.border}; color: ${t.muted}; font-size: 10px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; white-space: nowrap; }
.qcard-body { margin: 16px 0 0; padding: 14px 16px; border-left: 3px solid ${t.accent}; border-radius: 8px; background: ${t.assistantBg}; color: ${t.text}; font-size: 15px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; }
.qcard-body a { color: ${t.accent}; }
.qcard-body code { background: ${t.codeBg}; color: ${t.codeText}; padding: 1px 5px; border-radius: 4px; font-family: ${MONO_STACK}; font-size: 13px; }
.qcard-foot { display: flex; justify-content: space-between; gap: 8px; margin-top: 16px; font-size: 11px; color: ${t.muted}; }
.qcard-title { overflow-wrap: anywhere; }
.qcard-brand { white-space: nowrap; }
`
}

/** Style-preset chrome scoped to the card (mono type, corners, glows). */
function presetOverrides(theme: ThemeId, t: ThemeTokens): string {
  switch (theme) {
    case "arknights":
      return `.qcard { font-family: ${MONO_STACK}; border-radius: 4px; border-left: 3px solid ${t.accent}; }
.qcard-author { text-transform: uppercase; letter-spacing: 0.04em; }
.qcard-body { border-radius: 2px; }`
    case "cyberpunk":
      return `.qcard { font-family: ${MONO_STACK}; border-radius: 0; border-color: ${t.accent}; box-shadow: 0 0 18px ${alpha(t.accent)} inset; }
.qcard-author { text-shadow: 0 0 8px ${t.accent}; }
.qcard-body { border-radius: 0; }`
    case "terminal":
      return `.qcard { font-family: ${MONO_STACK}; border-radius: 0; border-style: dashed; }
.qcard-avatar { border-radius: 0; }
.qcard-body { border-radius: 0; }
.qcard-author::before { content: "> "; }`
    case "sakura":
      return `.qcard { border-radius: 24px; }
.qcard-body { border-radius: 16px; }
.qcard-author::after { content: " ✿"; }`
    case "aurora":
      return `.qcard { box-shadow: 0 4px 24px ${alpha(t.accent)}; }
.qcard-author { text-shadow: 0 0 12px ${alpha(t.accent)}; }`
    case "genshin":
      return `.qcard { font-family: Georgia, "Iowan Old Style", "Songti SC", serif; border-top: 3px solid ${t.accent}; }
.qcard-author::after { content: " ✦"; }`
    case "honkai":
      return `.qcard { background-image: radial-gradient(${alpha(t.accent)} 1px, transparent 1px); background-size: 20px 20px; }
.qcard-author { text-shadow: 0 0 10px ${alpha(t.accent)}; }`
    default:
      return ""
  }
}

function alpha(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return "rgba(128,128,128,0.12)"
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},0.12)`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Self-contained HTML export. Inlines all styles + a tiny client-side script
// for collapsible sections; no external network requests at view time.

import type { UIMessage } from "ai"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import { THEMES, type ThemeId, type ThemeTokens } from "./syntax-themes"
import { getStylePreset } from "./style-presets"
import { buildWallpaperBackdropCss } from "./theme-wallpaper"
import { renderSafeInlineMarkdown } from "./safe-inline-markdown"

export interface BeautifulHtmlOptions {
  session: ChatSession
  messages: StoredMessage[]
  exportedAt: Date
  theme?: ThemeId
  /** Inline custom theme tokens — overrides `theme` when provided. */
  customTheme?: ThemeTokens
  includeMetadata?: boolean
  includeTimestamps?: boolean
  /** Show <details> blocks for tool calls / reasoning. Default true. */
  expandDetails?: boolean
  /**
   * Inlined theme wallpaper data-URL. When present, a photo backdrop (with a
   * legibility scrim) is laid behind the export. Resolved by the caller via
   * `resolveThemeWallpaper` so this module stays pure/sync.
   */
  wallpaperDataUrl?: string
}

export function exportToBeautifulHtml(options: BeautifulHtmlOptions): string {
  const {
    session,
    messages,
    exportedAt,
    theme = "light",
    customTheme,
    includeMetadata = true,
    includeTimestamps = true,
    expandDetails = true,
    wallpaperDataUrl,
  } = options
  const tokens = customTheme ?? THEMES[theme]
  const preset = getStylePreset(theme)
  const banner = preset?.bannerText
    ? `<div class="preset-banner">${escapeHtml(preset.bannerText)}</div>\n`
    : ""
  const footerTag = preset?.footerText ? ` · ${escapeHtml(preset.footerText)}` : ""
  // Wallpaper backdrop is appended LAST so its transparent-body rule wins over
  // the base `body{background:${t.bg}}` while the preset chrome layers on top.
  const wallpaperCss = wallpaperDataUrl ? buildWallpaperBackdropCss(wallpaperDataUrl, tokens) : ""

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(session.title)}</title>
<style>${stylesheet(tokens)}${preset ? preset.css(tokens) : ""}${wallpaperCss}</style>
</head>
<body>
<main class="container">
${banner}${renderHeader(session, exportedAt, includeMetadata)}
<section class="conversation">
${messages.map((m) => renderMessage(m, { includeTimestamps, expandDetails })).join("\n")}
</section>
<footer class="exported">Exported from Cognia · ${escapeHtml(exportedAt.toLocaleString())}${footerTag}</footer>
</main>
</body>
</html>`
}

// ---------------------------------------------------------------------------

function renderHeader(session: ChatSession, exportedAt: Date, includeMetadata: boolean): string {
  if (!includeMetadata) {
    return `<header><h1>${escapeHtml(session.title)}</h1></header>`
  }
  return `<header>
  <h1>${escapeHtml(session.title)}</h1>
  <dl class="meta">
    <dt>Date</dt><dd>${escapeHtml(new Date(session.createdAt).toLocaleDateString())}</dd>
    ${session.model ? `<dt>Model</dt><dd>${escapeHtml(session.model)}</dd>` : ""}
    ${session.kind ? `<dt>Kind</dt><dd>${escapeHtml(session.kind)}</dd>` : ""}
    <dt>Exported</dt><dd>${escapeHtml(exportedAt.toLocaleString())}</dd>
  </dl>
  ${session.systemPrompt ? `<details><summary>System prompt</summary><pre>${escapeHtml(session.systemPrompt)}</pre></details>` : ""}
</header>`
}

function renderMessage(
  message: StoredMessage,
  opts: { includeTimestamps: boolean; expandDetails: boolean }
): string {
  const role = message.role
  const ts = opts.includeTimestamps
    ? `<time>${escapeHtml(new Date(message.createdAt).toLocaleString())}</time>`
    : ""
  return `<article class="message message-${role}">
  <header>
    <span class="role">${escapeHtml(roleLabel(role))}</span>
    ${ts}
  </header>
  <div class="parts">
    ${message.parts.map((p) => renderPart(p, opts.expandDetails)).join("\n")}
  </div>
</article>`
}

function renderPart(part: UIMessage["parts"][number], expandDetails: boolean): string {
  if (part.type === "text") {
    return `<div class="text">${renderSafeInlineMarkdown(escapeHtml((part as { text: string }).text))}</div>`
  }
  if (part.type === "reasoning") {
    const text = (part as { text: string }).text ?? ""
    return `<details ${expandDetails ? "" : "open"} class="reasoning">
  <summary>💭 Thinking</summary>
  <pre>${escapeHtml(text)}</pre>
</details>`
  }
  if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
    const tp = part as {
      type: string
      state?: string
      input?: unknown
      output?: unknown
      errorText?: string
    }
    const name = tp.type === "dynamic-tool" ? "tool" : tp.type.slice("tool-".length)
    return `<details ${expandDetails ? "open" : ""} class="tool">
  <summary>🔧 ${escapeHtml(name)} <span class="state">[${escapeHtml(tp.state ?? "?")}]</span></summary>
  ${tp.input !== undefined ? `<h4>Input</h4><pre>${escapeHtml(safeJson(tp.input))}</pre>` : ""}
  ${tp.output !== undefined ? `<h4>Output</h4><pre>${escapeHtml(typeof tp.output === "string" ? tp.output : safeJson(tp.output))}</pre>` : ""}
  ${tp.errorText ? `<p class="error">❌ ${escapeHtml(tp.errorText)}</p>` : ""}
</details>`
  }
  if (part.type === "file") {
    const fp = part as { url?: string; mediaType?: string; filename?: string }
    const label = fp.filename ?? fp.mediaType ?? "file"
    if (fp.url && isImageFile(fp)) {
      return `<figure class="image"><img src="${escapeHtml(fp.url)}" alt="${escapeHtml(label)}" loading="lazy"><figcaption>${escapeHtml(label)}</figcaption></figure>`
    }
    return fp.url
      ? `<p class="file">📎 <a href="${escapeHtml(fp.url)}">${escapeHtml(label)}</a></p>`
      : `<p class="file">📎 ${escapeHtml(label)}</p>`
  }
  if (part.type === "source-url") {
    const sp = part as { url: string; title?: string }
    return `<p class="source">🔗 <a href="${escapeHtml(sp.url)}">${escapeHtml(sp.title ?? sp.url)}</a></p>`
  }
  return ""
}

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "👤 You"
    case "assistant":
      return "🤖 Assistant"
    case "system":
      return "⚙️ System"
    default:
      return role
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function stylesheet(t: ThemeTokens): string {
  return `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: ${t.bg}; color: ${t.text}; line-height: 1.6; }
.container { max-width: 920px; margin: 0 auto; padding: 32px 24px 80px; }
header h1 { margin: 0 0 8px; font-size: 28px; color: ${t.accent}; }
header dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 12px 0 0; font-size: 13px; color: ${t.muted}; }
header dl.meta dt { font-weight: 600; }
header dl.meta dd { margin: 0; }
header details summary { cursor: pointer; margin: 12px 0 6px; color: ${t.muted}; font-size: 13px; }
header details pre { background: ${t.codeBg}; color: ${t.codeText}; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
.conversation { margin-top: 24px; }
.message { background: ${t.surface}; border: 1px solid ${t.border}; border-radius: 12px; padding: 16px 18px; margin-bottom: 12px; }
.message-user { background: ${t.userBg}; }
.message-assistant { background: ${t.assistantBg}; }
.message > header { display: flex; align-items: center; justify-content: space-between; margin: 0 0 8px; font-size: 13px; }
.message .role { font-weight: 600; color: ${t.accent}; }
.message time { color: ${t.muted}; }
.parts > * { margin: 6px 0; }
.text { white-space: pre-wrap; word-wrap: break-word; }
.text a { color: ${t.accent}; }
.image { margin: 10px 0; }
.image img { display: block; max-width: 100%; max-height: 720px; border-radius: 8px; object-fit: contain; }
.image figcaption { margin-top: 4px; color: ${t.muted}; font-size: 12px; }
pre { background: ${t.codeBg}; color: ${t.codeText}; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; line-height: 1.45; }
details.tool, details.reasoning { background: ${t.detailBg}; border: 1px solid ${t.border}; border-radius: 6px; padding: 8px 12px; }
details summary { cursor: pointer; font-weight: 500; }
details summary .state { color: ${t.muted}; font-weight: 400; margin-left: 6px; }
details h4 { margin: 8px 0 4px; font-size: 13px; }
details .error { color: #dc2626; margin: 6px 0 0; }
.file, .source { font-size: 14px; color: ${t.accent}; }
.exported { margin-top: 32px; text-align: center; color: ${t.muted}; font-size: 12px; }
@media (max-width: 600px) { .container { padding: 16px; } header h1 { font-size: 22px; } }
`
}

function isImageFile(file: { url?: string; mediaType?: string; filename?: string }): boolean {
  return Boolean(
    file.mediaType?.startsWith("image/") ||
    file.url?.startsWith("data:image/") ||
    file.filename?.match(/\.(?:avif|gif|jpe?g|png|svg|webp)$/i)
  )
}

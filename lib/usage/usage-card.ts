// Usage share card: aggregates `sessionUsage` rows into headline stats and
// renders them as a self-contained HTML card (no external requests), styled by
// the same theme + style-preset system the chat HTML export uses. The card is
// shared through the zero-knowledge share pipeline as the `usage-card` kind
// and rasterized to PNG (html2canvas) for quick image sharing.

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { aggregateByModel, effectiveCostUsd } from "@/lib/usage/session-analytics"
import { formatCost, formatDuration, formatTokens } from "@/types/system/usage"
import { THEMES, type ThemeId, type ThemeTokens } from "@/lib/export/html/syntax-themes"
import { getStylePreset } from "@/lib/export/html/style-presets"

export interface UsageCardStats {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
  durationMs: number
  /** Billable turns (rows). */
  turns: number
  /** Distinct sessions represented in the rows. */
  sessions: number
  /** Distinct calendar days (UTC) with at least one turn. */
  activeDays: number
  /** Model with the highest token volume, or null when empty. */
  topModel: string | null
  /** Earliest / latest row timestamps, null when empty. */
  from: number | null
  to: number | null
}

/** Pure aggregation of usage rows into the stats the card displays. */
export function collectUsageCardStats(rows: readonly SessionUsageRow[]): UsageCardStats {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let costUsd = 0
  let durationMs = 0
  let from: number | null = null
  let to: number | null = null
  const sessions = new Set<string>()
  const days = new Set<string>()

  for (const r of rows) {
    inputTokens += r.inputTokens
    outputTokens += r.outputTokens
    cacheReadTokens += r.cacheReadTokens
    costUsd += effectiveCostUsd(r)
    durationMs += r.durationMs
    sessions.add(r.sessionId)
    days.add(new Date(r.at).toISOString().slice(0, 10))
    if (from == null || r.at < from) from = r.at
    if (to == null || r.at > to) to = r.at
  }

  const byModel = aggregateByModel(rows)
  const topModel =
    byModel.length > 0
      ? [...byModel].sort(
          (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
        )[0].model
      : null

  return {
    totalTokens: inputTokens + outputTokens + cacheReadTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costUsd,
    durationMs,
    turns: rows.length,
    sessions: sessions.size,
    activeDays: days.size,
    topModel,
    from,
    to,
  }
}

export interface UsageCardOptions {
  stats: UsageCardStats
  /** Visual style; defaults to the flagship "arknights" look. */
  theme?: ThemeId
  customTheme?: ThemeTokens
  /** Card headline; defaults to "Cognia Usage Archive". */
  title?: string
  /** Optional owner handle rendered under the title. */
  ownerName?: string
  /** Human label of the aggregated range, e.g. "Last 7 days". */
  rangeLabel?: string
  generatedAt: Date
}

interface CardLabels {
  banner: string
  tokens: string
  cost: string
  time: string
  sessions: string
  signals: string
  activeDays: string
  topModel: string
}

// The Arknights style uses in-universe flavor labels (mirroring the PRTS
// fan-card aesthetic); every other style keeps literal metric names. Card
// content is generated-export text, English by convention like the chat
// HTML export (`beautiful-html.ts`).
const ARKNIGHTS_LABELS: CardLabels = {
  banner: "RHODES-STYLE TACTICAL ARCHIVE",
  tokens: "ORIGINIUM COMPUTE",
  cost: "SUPPLY COST",
  time: "OPERATION TIME",
  sessions: "OPERATIONS",
  signals: "SIGNALS",
  activeDays: "ACTIVE DAYS",
  topModel: "PRIMARY OPERATOR",
}

const GENERIC_LABELS: CardLabels = {
  banner: "USAGE ARCHIVE",
  tokens: "TOTAL TOKENS",
  cost: "TOTAL COST",
  time: "COMPUTE TIME",
  sessions: "SESSIONS",
  signals: "TURNS",
  activeDays: "ACTIVE DAYS",
  topModel: "TOP MODEL",
}

/**
 * Card markup + scoped `<style>`, embeddable either in a full document
 * (`buildUsageCardHtml`) or directly in the app DOM for PNG capture.
 */
export function renderUsageCardFragment(options: UsageCardOptions): string {
  const theme = options.theme ?? "arknights"
  const t = options.customTheme ?? THEMES[theme]
  const preset = getStylePreset(theme)
  const labels = theme === "arknights" ? ARKNIGHTS_LABELS : GENERIC_LABELS
  const s = options.stats
  const title = options.title ?? "Cognia Usage Archive"
  const banner = preset?.bannerText ?? labels.banner

  const tiles: { label: string; value: string }[] = [
    { label: labels.tokens, value: formatTokens(s.totalTokens) },
    { label: labels.cost, value: formatCost(s.costUsd) },
    { label: labels.time, value: formatDuration(s.durationMs) },
    { label: labels.sessions, value: String(s.sessions) },
    { label: labels.signals, value: String(s.turns) },
    { label: labels.activeDays, value: String(s.activeDays) },
  ]

  const rangeTag = options.rangeLabel
    ? `<span class="ucard-range">${escapeHtml(options.rangeLabel)}</span>`
    : ""
  const owner = options.ownerName
    ? `<p class="ucard-owner">@${escapeHtml(options.ownerName)}</p>`
    : ""
  const topModel = s.topModel
    ? `<div class="ucard-model"><span>${escapeHtml(labels.topModel)}</span><strong>${escapeHtml(s.topModel)}</strong></div>`
    : ""
  const footerTag = preset?.footerText ? `${escapeHtml(preset.footerText)} · ` : ""

  return `<style>${cardStylesheet(t)}${preset ? presetOverrides(theme, t) : ""}</style>
<div class="ucard" data-theme="${escapeHtml(theme)}">
  <div class="ucard-banner"><span>${escapeHtml(banner)}</span>${rangeTag}</div>
  <h1 class="ucard-title">${escapeHtml(title)}</h1>
  ${owner}
  <div class="ucard-grid">
    ${tiles
      .map(
        (tile) =>
          `<div class="ucard-tile"><span class="ucard-label">${escapeHtml(tile.label)}</span><span class="ucard-value">${escapeHtml(tile.value)}</span></div>`
      )
      .join("\n    ")}
  </div>
  ${topModel}
  <div class="ucard-footer"><span>${footerTag}Generated by Cognia</span><span>${escapeHtml(options.generatedAt.toLocaleString())}</span></div>
</div>`
}

/** Full self-contained HTML document for the share pipeline. */
export function buildUsageCardHtml(options: UsageCardOptions): string {
  const theme = options.theme ?? "arknights"
  const t = options.customTheme ?? THEMES[theme]
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(options.title ?? "Cognia Usage Archive")}</title>
<style>body { margin: 0; padding: 24px; background: ${t.bg}; display: flex; justify-content: center; }</style>
</head>
<body>
${renderUsageCardFragment(options)}
</body>
</html>`
}

function cardStylesheet(t: ThemeTokens): string {
  return `
.ucard { box-sizing: border-box; width: 480px; max-width: 100%; padding: 24px; border: 1px solid ${t.border}; border-radius: 14px; background: ${t.bg}; color: ${t.text}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.ucard * { box-sizing: border-box; }
.ucard-banner { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: ${t.muted}; }
.ucard-range { padding: 2px 10px; border-radius: 999px; background: ${t.accent}; color: ${t.bg}; letter-spacing: 0.1em; }
.ucard-title { margin: 10px 0 2px; font-size: 26px; line-height: 1.2; color: ${t.accent}; overflow-wrap: anywhere; }
.ucard-owner { margin: 0 0 6px; font-size: 13px; color: ${t.muted}; }
.ucard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 16px; }
.ucard-tile { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid ${t.border}; border-radius: 8px; background: ${t.surface}; }
.ucard-label { font-size: 10px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: ${t.muted}; }
.ucard-value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ucard-model { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-top: 12px; padding: 10px 14px; border: 1px dashed ${t.border}; border-radius: 8px; font-size: 12px; color: ${t.muted}; }
.ucard-model strong { color: ${t.text}; font-size: 13px; overflow-wrap: anywhere; text-align: right; }
.ucard-footer { display: flex; justify-content: space-between; gap: 8px; margin-top: 18px; font-size: 11px; color: ${t.muted}; }
`
}

/** Style-preset chrome scoped to the card (grid bg, mono type, sharp corners). */
function presetOverrides(theme: ThemeId, t: ThemeTokens): string {
  const mono = `"JetBrains Mono", "Cascadia Code", "SFMono-Regular", Consolas, "Noto Sans Mono", monospace`
  switch (theme) {
    case "arknights":
      return `
.ucard { font-family: ${mono}; border-radius: 4px; border-left: 3px solid ${t.accent}; background-image: linear-gradient(${alpha(t.accent)} 1px, transparent 1px), linear-gradient(90deg, ${alpha(t.accent)} 1px, transparent 1px); background-size: 26px 26px; }
.ucard-banner span:first-child { color: ${t.accent}; }
.ucard-title { text-transform: uppercase; letter-spacing: 0.06em; }
.ucard-tile, .ucard-model { border-radius: 2px; }
.ucard-footer { text-transform: uppercase; letter-spacing: 0.14em; font-size: 10px; }
`
    case "cyberpunk":
      return `
.ucard { font-family: ${mono}; border-radius: 0; border-color: ${t.accent}; box-shadow: 0 0 18px ${alpha(t.accent)} inset; }
.ucard-title { text-shadow: 0 0 10px ${t.accent}; text-transform: uppercase; }
.ucard-tile { border-radius: 0; }
`
    case "terminal":
      return `
.ucard { font-family: ${mono}; border-radius: 0; border-style: dashed; }
.ucard-tile { border-radius: 0; border-style: dashed; }
.ucard-title::before { content: "$ "; }
`
    case "sakura":
      return `
.ucard { border-radius: 22px; }
.ucard-tile { border-radius: 14px; }
.ucard-title::after { content: " ✿"; }
`
    default:
      return ""
  }
}

function alpha(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return "rgba(128,128,128,0.12)"
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},0.1)`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

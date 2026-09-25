/**
 * Markdown rendering for chat surfaces (the `/research` command's answer).
 *
 * Every user-facing string comes from the plugin's own i18n bundle
 * (`plugin.json` → `i18n.locales`) through the caller's `ctx.i18n.t`, so the
 * card reads in the user's language — one language per card, never an
 * English + Chinese pair glued together. The agent-tool result text
 * ({@link errorText}) is model-facing and stays English.
 */
import type { ResearchErrorCode } from "./errors"
import type { Citation, DeepResearchResult, DeepSearchResult } from "./types"

/** The plugin's `ctx.i18n.t`. */
export type ResearchTranslate = (key: string, params?: Record<string, string | number>) => string

// Explicit locale: bare toLocaleString picks up the host's, so digit grouping
// differed between user machines for the same run.
function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US")
}

export function renderResultCard(
  question: string,
  result: DeepSearchResult,
  t: ResearchTranslate
): string {
  const lines: string[] = []
  lines.push(`### 🔬 ${t("card.title")}`)
  lines.push(`> ${question}`)
  lines.push("")
  lines.push(result.answer.trim())
  const sources = renderSources(result.citations, t)
  if (sources) {
    lines.push("")
    lines.push(sources)
  }
  lines.push("")
  lines.push(renderFooter(result, t))
  return lines.join("\n")
}

function renderSources(citations: Citation[], t: ResearchTranslate): string {
  if (citations.length === 0) return ""
  const seen = new Set<string>()
  const items: string[] = []
  for (const c of citations) {
    if (seen.has(c.url)) continue
    seen.add(c.url)
    const date = c.publishedDate?.trim()
    items.push(
      `${items.length + 1}. [${c.title || c.url}](${c.url})${date ? ` (${date.slice(0, 24)})` : ""}`
    )
  }
  return `**${t("card.sources")}**\n${items.join("\n")}`
}

function renderFooter(result: DeepSearchResult, t: ResearchTranslate): string {
  const note = result.aborted
    ? t("card.noteCancelled")
    : result.gaveUp
      ? t("card.noteBudget")
      : t("card.noteChecked")
  return `*${t("card.footer", {
    steps: result.steps.length,
    tokens: formatTokens(result.usage.totalTokens),
    note,
  })}*`
}

/** Render a DeepResearch report (already full markdown) with a small footer. */
export function renderReportCard(result: DeepResearchResult, t: ResearchTranslate): string {
  const ran = result.sections.length
  const planned = result.outline.sections.length
  const sections = ran < planned ? `${ran}/${planned}` : `${ran}`
  const footer = t(result.gaveUp ? "report.footerPartial" : "report.footer", {
    sections,
    tokens: formatTokens(result.usage.totalTokens),
  })
  return `${result.report.trim()}\n\n*${footer}*`
}

/**
 * i18n key of the card for a failure the user can act on — one per
 * {@link ResearchErrorCode}: a card that only says "something went wrong"
 * costs the user a support round-trip, and every code below names a
 * different setting to change.
 */
const ERROR_CARD_KEYS: Record<ResearchErrorCode, string> = {
  NO_PROVIDER: "error.noProvider",
  NO_AI_PERMISSION: "error.noAiPermission",
  WEB_DISABLED: "error.webDisabled",
  NO_SEARCH_PROVIDER: "error.noSearchProvider",
  RATE_LIMITED: "error.rateLimited",
  BLOCKED: "error.blocked",
  TOOL_UNAVAILABLE: "error.toolUnavailable",
  FAILED: "error.failed",
}

/** One-line text summaries for the agent-tool return value. */
const ERROR_TEXT: Record<ResearchErrorCode, string> = {
  NO_PROVIDER: "No AI model provider is configured for the deep-research plugin.",
  NO_AI_PERMISSION:
    "The deep-research plugin was not granted permission to use the AI model (ai:chat / ai:embed).",
  WEB_DISABLED: "Deep Research is disabled because web tools are turned off.",
  NO_SEARCH_PROVIDER: "No web search provider is configured — enable one in Settings → Search.",
  RATE_LIMITED: "Deep Research hit the outbound web rate limit; try again shortly.",
  BLOCKED: "Deep Research was blocked by the PII / SSRF guard.",
  TOOL_UNAVAILABLE: "This host does not expose the web_search / web_fetch tools.",
  FAILED: "Deep Research failed.",
}

/** Render the chat card for a classified failure, appending the detail. */
export function renderErrorCard(
  code: ResearchErrorCode,
  t: ResearchTranslate,
  detail?: string
): string {
  const card = `⚠️ ${t(ERROR_CARD_KEYS[code])}`
  return detail && code === "FAILED" ? `${card}\n\n\`${detail}\`` : card
}

/** One-line text summary for the agent-tool return value. */
export function errorText(code: ResearchErrorCode, detail?: string): string {
  const text = ERROR_TEXT[code]
  return detail && code === "FAILED" ? `${text} ${detail}` : text
}

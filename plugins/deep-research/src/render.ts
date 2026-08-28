/**
 * Markdown rendering for chat surfaces (tool result + slash card). The plugin
 * manages its own user-facing strings (bilingual), independent of the app's
 * next-intl baseline — same convention the other in-tree plugins follow.
 */
import type { ResearchErrorCode } from "./errors"
import type { Citation, DeepResearchResult, DeepSearchResult } from "./types"

export function renderResultCard(question: string, result: DeepSearchResult): string {
  const lines: string[] = []
  lines.push(`### 🔬 Deep Research`)
  lines.push(`> ${question}`)
  lines.push("")
  lines.push(result.answer.trim())
  const sources = renderSources(result.citations)
  if (sources) {
    lines.push("")
    lines.push(sources)
  }
  lines.push("")
  lines.push(renderFooter(result))
  return lines.join("\n")
}

function renderSources(citations: Citation[]): string {
  if (citations.length === 0) return ""
  const seen = new Set<string>()
  const items: string[] = []
  for (const c of citations) {
    if (seen.has(c.url)) continue
    seen.add(c.url)
    items.push(`${items.length + 1}. [${c.title || c.url}](${c.url})`)
  }
  return `**Sources**\n${items.join("\n")}`
}

function renderFooter(result: DeepSearchResult): string {
  const steps = result.steps.length
  const tokens = result.usage.totalTokens.toLocaleString()
  const note = result.gaveUp
    ? "⚠️ answered under budget limits — may be incomplete"
    : "✓ evidence-checked"
  return `*${steps} steps · ${tokens} tokens · ${note}*`
}

/** Render a DeepResearch report (already full markdown) with a small footer. */
export function renderReportCard(result: DeepResearchResult): string {
  const footer = `*${result.sections.length} sections · ${result.usage.totalTokens.toLocaleString()} tokens · deep research report*`
  return `${result.report.trim()}\n\n${footer}`
}

/**
 * Bilingual card for a failure the user can act on.
 *
 * One entry per {@link ResearchErrorCode}: a card that only says "something
 * went wrong" costs the user a support round-trip, and every code below names
 * a different setting to change.
 */
const ERROR_CARDS: Record<ResearchErrorCode, string> = {
  NO_PROVIDER:
    "⚠️ **Deep Research** needs an AI model provider.\n\n" +
    "No model is configured for this plugin to use. Configure a provider in settings, then try again.\n\n" +
    "（深度研究需要先在设置中配置一个 AI 模型提供方。）",
  NO_AI_PERMISSION:
    "⚠️ **Deep Research** needs permission to use the AI model.\n\n" +
    "The research loop calls the model to rewrite queries, judge sources, and draft the answer. " +
    "Grant the model access when prompted, then try again.\n\n" +
    "（深度研究需要「使用 AI 模型」的权限，请在弹出的授权提示中允许后重试。）",
  WEB_DISABLED:
    "⚠️ **Deep Research** is disabled because web tools are turned off.\n\n" +
    "Enable web tools in Settings, then try again.\n\n" +
    "（联网工具已关闭，请在设置中启用后重试。）",
  NO_SEARCH_PROVIDER:
    "⚠️ **Deep Research** needs a web search provider.\n\n" +
    "Enable one and add its API key in Settings → Search, then try again.\n\n" +
    "（请在「设置 → 搜索」中启用一个搜索服务并填写 API Key。）",
  RATE_LIMITED:
    "⚠️ **Deep Research** hit the outbound rate limit.\n\n" +
    "Too many web requests in a short window. Wait a moment, then try again.\n\n" +
    "（联网请求过于频繁，请稍后重试。）",
  BLOCKED:
    "⚠️ **Deep Research** was blocked by a safety guard.\n\n" +
    "The request contained sensitive data, or targeted an address the app refuses to fetch.\n\n" +
    "（请求被安全策略拦截：包含敏感数据，或目标地址不被允许访问。）",
  TOOL_UNAVAILABLE:
    "⚠️ **Deep Research** cannot reach the app's web tools on this host.\n\n" +
    "（当前运行环境未提供联网搜索/抓取工具。）",
  FAILED: "⚠️ **Deep Research** failed.",
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
export function renderErrorCard(code: ResearchErrorCode, detail?: string): string {
  const card = ERROR_CARDS[code]
  return detail && code === "FAILED" ? `${card}\n\n\`${detail}\`` : card
}

/** One-line text summary for the agent-tool return value. */
export function errorText(code: ResearchErrorCode, detail?: string): string {
  const text = ERROR_TEXT[code]
  return detail && code === "FAILED" ? `${text} ${detail}` : text
}

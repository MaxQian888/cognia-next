/**
 * Markdown rendering for chat surfaces (tool result + slash card). The plugin
 * manages its own user-facing strings (bilingual), independent of the app's
 * next-intl baseline — same convention the other in-tree plugins follow.
 */
import type { BuildDepsResult } from "./runtime"
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

/** Bilingual error card for missing prerequisites. */
export function renderErrorCard(built: Extract<BuildDepsResult, { ok: false }>): string {
  if (built.error === "NO_PROVIDER") {
    return (
      "⚠️ **Deep Research** needs an AI model provider.\n\n" +
      "No model is configured for this plugin to use. Configure a provider in settings, then try again.\n\n" +
      "（深度研究需要先在设置中配置一个 AI 模型提供方。）"
    )
  }
  if (built.error === "NO_AI_PERMISSION") {
    return (
      "⚠️ **Deep Research** needs permission to use the AI model.\n\n" +
      "The research loop calls the model to rewrite queries, judge sources, and draft the answer. " +
      "Grant the model access when prompted, then try again.\n\n" +
      "（深度研究需要「使用 AI 模型」的权限，请在弹出的授权提示中允许后重试。）"
    )
  }
  const provider = built.provider ?? "exa"
  return (
    `⚠️ **Deep Research** needs a \`${provider}\` API key.\n\n` +
    `Add your ${provider} key in the Deep Research plugin settings (stored securely), then try again.\n\n` +
    `（请在「深度研究」插件设置里填入 ${provider} 的 API Key。）`
  )
}

/** One-line text summary for the agent-tool return value. */
export function errorText(built: Extract<BuildDepsResult, { ok: false }>): string {
  if (built.error === "NO_PROVIDER") {
    return "No AI model provider is configured for the deep-research plugin."
  }
  if (built.error === "NO_AI_PERMISSION") {
    return "The deep-research plugin was not granted permission to use the AI model (ai:chat / ai:embed)."
  }
  return `Missing ${built.provider ?? "search"} API key — configure it in the Deep Research plugin settings.`
}

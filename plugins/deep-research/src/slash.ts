/**
 * The `/research <question>` slash command — a thin convenience trigger over
 * the same in-plugin engine. The plugin slash registry hands the handler only
 * a lightweight context (no streaming), so this runs the loop to completion and
 * returns the final cited card as the command's chat response. For live
 * step-by-step progress, the `deep_research` agent tool is the richer path.
 *
 * `@/lib/slash-commands/registry` is the host's SDK slash registry (the same
 * surface every plugin uses, e.g. zhihu-content-pipeline) — not feature
 * coupling. The engine itself imports nothing from the host.
 */
import type { SlashCommandResult } from "@/lib/slash-commands/registry"
import type { PluginContext } from "@/types/plugin"
import { readEngineConfig } from "./config"
import { runDeepResearch } from "./engine/deepresearch"
import { runDeepSearch } from "./engine/deepsearch"
import { renderErrorCard, renderReportCard, renderResultCard } from "./render"
import { buildEngineDeps } from "./runtime"

const USAGE =
  "Usage:\n" +
  "- `/research <question>` — a cited answer.\n" +
  "- `/research report <topic>` — a multi-section cited report.\n\n" +
  "（用法：`/research <问题>` 给出带引用的答案；`/research report <主题>` 生成多章节研究报告。）"

export async function handleResearchSlash(
  ctx: PluginContext,
  args: string
): Promise<SlashCommandResult> {
  const trimmed = (args ?? "").trim()
  if (!trimmed) return { message: USAGE }

  const reportMatch = trimmed.match(/^report\s+(.+)/i)
  const isReport = reportMatch !== null
  const topic = isReport ? reportMatch[1].trim() : trimmed
  if (!topic) return { message: USAGE }

  const built = await buildEngineDeps(ctx)
  if (!built.ok) return { message: renderErrorCard(built) }

  try {
    const config = readEngineConfig(ctx)
    if (isReport) {
      const report = await runDeepResearch(topic, built.deps, config)
      return { message: renderReportCard(report) }
    }
    const result = await runDeepSearch(topic, built.deps, config)
    return { message: renderResultCard(topic, result) }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { message: `⚠️ Deep Research failed: ${detail}` }
  }
}

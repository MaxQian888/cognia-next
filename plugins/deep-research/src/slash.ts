/**
 * The `/research <question>` slash command — a thin convenience trigger over
 * the same in-plugin engine. It runs the loop to completion and returns the
 * final cited card as the command's chat response, so the report lands in the
 * conversation the user typed in. (For live step-by-step progress, the
 * `deep_research` agent tool is the richer path.)
 */
import type { PluginCommandContext, PluginCommandResult, PluginContext } from "@cognia/plugin-sdk"

import { readEngineConfig } from "./config"
import { runDeepResearch } from "./engine/deepresearch"
import { runDeepSearch } from "./engine/deepsearch"
import { classifyResearchError } from "./errors"
import { renderErrorCard, renderReportCard, renderResultCard } from "./render"
import { buildEngineDeps } from "./runtime"

const USAGE =
  "Usage:\n" +
  "- `/research <question>` — a cited answer.\n" +
  "- `/research report <topic>` — a multi-section cited report.\n\n" +
  "（用法：`/research <问题>` 给出带引用的答案；`/research report <主题>` 生成多章节研究报告。）"

export async function handleResearchSlash(
  ctx: PluginContext,
  args: string,
  commandContext?: PluginCommandContext
): Promise<PluginCommandResult> {
  const trimmed = (args ?? "").trim()
  if (!trimmed) return { handled: true, message: USAGE }

  const reportMatch = trimmed.match(/^report\s+(.+)/i)
  const isReport = reportMatch !== null
  const topic = isReport ? reportMatch[1].trim() : trimmed
  if (!topic) return { handled: true, message: USAGE }

  // The invoking session routes every model call and web-tool invocation this
  // run makes, so the work is billed to the conversation the user is in.
  const deps = buildEngineDeps(ctx, {
    ...(commandContext?.sessionId ? { sessionId: commandContext.sessionId } : {}),
  })

  try {
    const config = readEngineConfig(ctx)
    if (isReport) {
      const report = await runDeepResearch(topic, deps, config)
      return {
        handled: true,
        message: renderReportCard(report),
        payload: {
          mode: "report",
          title: report.title,
          citations: report.citations,
          sections: report.sections.length,
          tokens: report.usage.totalTokens,
        },
      }
    }
    const result = await runDeepSearch(topic, deps, config)
    return {
      handled: true,
      message: renderResultCard(topic, result),
      payload: {
        mode: "search",
        citations: result.citations,
        gaveUp: result.gaveUp,
        steps: result.steps.length,
        tokens: result.usage.totalTokens,
      },
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { handled: true, message: renderErrorCard(classifyResearchError(err), detail) }
  }
}

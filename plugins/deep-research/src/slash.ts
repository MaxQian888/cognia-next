/**
 * The `/research <question>` slash command — a thin convenience trigger over
 * the same in-plugin engine. It runs the loop to completion and returns the
 * final cited card as the command's chat response, so the report lands in the
 * conversation the user typed in. Hosts can supply cancellation and progress
 * through the command context.
 */
import type { PluginCommandContext, PluginCommandResult, PluginContext } from "@cognia/plugin-sdk"

import { persistReport } from "./artifacts"
import { readEngineConfig } from "./config"
import { runDeepResearch } from "./engine/deepresearch"
import { runDeepSearch } from "./engine/deepsearch"
import { classifyResearchError } from "./errors"
import { renderErrorCard, renderReportCard, renderResultCard } from "./render"
import { buildEngineDeps } from "./runtime"
import { resolveConfig, type ResearchDepth } from "./tool"
import type { ResearchMode } from "./types"

export interface ParsedResearchArgs {
  topic: string
  mode: ResearchMode
  depth?: ResearchDepth
}

/**
 * Parse the slash tail: leading `report` and `quick|standard|deep` keywords in
 * any order, then the topic. A topic that happens to START with one of the
 * keywords ("/research report cards") is split — documented trade-off of a
 * keyword-prefix grammar, same as before.
 */
export function parseResearchArgs(args: string): ParsedResearchArgs | null {
  let rest = (args ?? "").trim()
  if (!rest) return null
  let mode: ResearchMode = "search"
  let depth: ResearchDepth | undefined
  while (true) {
    const m = rest.match(/^(report|quick|standard|deep)\s+(\S[\s\S]*)$/i)
    if (!m) break
    const keyword = m[1].toLowerCase()
    if (keyword === "report") mode = "report"
    else depth = keyword as ResearchDepth
    rest = m[2].trim()
  }
  if (!rest) return null
  return { topic: rest, mode, ...(depth ? { depth } : {}) }
}

export async function handleResearchSlash(
  ctx: PluginContext,
  args: string,
  commandContext?: PluginCommandContext
): Promise<PluginCommandResult> {
  const t = ctx.i18n.t
  const parsed = parseResearchArgs(args)
  if (!parsed) return { handled: true, message: t("slash.usage") }

  // The invoking session routes every model call and web-tool invocation this
  // run makes, so the work is billed to the conversation the user is in.
  const deps = buildEngineDeps(ctx, {
    ...(commandContext?.signal ? { signal: commandContext.signal } : {}),
    ...(commandContext?.reportProgress ? { reportProgress: commandContext.reportProgress } : {}),
    ...(commandContext?.sessionId ? { sessionId: commandContext.sessionId } : {}),
  })

  try {
    const config = resolveConfig(readEngineConfig(ctx), parsed.depth)
    if (parsed.mode === "report") {
      const report = await runDeepResearch(parsed.topic, deps, config)
      // User-invoked, so the deliverable opens straight into the workspace —
      // the same gesture every other doc-producing plugin makes. A cancelled
      // run produced no real document, so there is nothing worth filing.
      const artifactId =
        !commandContext?.signal?.aborted && report.sections.length > 0
          ? await persistReport(ctx, report, {
              ...(commandContext?.sessionId ? { sessionId: commandContext.sessionId } : {}),
            })
          : undefined
      if (artifactId && !commandContext?.signal?.aborted) {
        try {
          ctx.artifact.openArtifact(artifactId)
        } catch (err) {
          ctx.logger.warn("deep-research: artifact panel could not be opened", err)
        }
      }
      return {
        handled: true,
        message: renderReportCard(report, t),
        payload: {
          mode: "report",
          title: report.title,
          citations: report.citations,
          sections: report.sections.length,
          plannedSections: report.outline.sections.length,
          gaveUp: report.gaveUp,
          tokens: report.usage.totalTokens,
          ...(artifactId ? { artifactId } : {}),
        },
      }
    }
    const result = await runDeepSearch(parsed.topic, deps, config)
    return {
      handled: true,
      message: renderResultCard(parsed.topic, result, t),
      payload: {
        mode: "search",
        citations: result.citations,
        gaveUp: result.gaveUp,
        ...(result.aborted ? { aborted: true } : {}),
        steps: result.steps.length,
        trace: result.steps,
        tokens: result.usage.totalTokens,
      },
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { handled: true, message: renderErrorCard(classifyResearchError(err), t, detail) }
  }
}

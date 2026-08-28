/**
 * The `deep_research` agent tool — the primary, streaming entry point. The
 * model calls it; `reportProgress` streams step cards into the chat and the
 * returned object renders as the result. Heavy lifting runs entirely in-plugin
 * over the host's public web + model APIs.
 */
import { defineTool, type PluginContext, type PluginToolContext } from "@cognia/plugin-sdk"

import { readEngineConfig } from "./config"
import { runDeepSearch } from "./engine/deepsearch"
import { runDeepResearch } from "./engine/deepresearch"
import { classifyResearchError } from "./errors"
import { errorText } from "./render"
import { buildEngineDeps } from "./runtime"
import type { DeepSearchConfig, ResearchMode } from "./types"

export type ResearchDepth = "quick" | "standard" | "deep"

export interface ResearchToolArgs {
  query?: string
  mode?: ResearchMode
  depth?: ResearchDepth
}

const DEPTH_PRESETS: Record<ResearchDepth, Partial<DeepSearchConfig>> = {
  quick: { maxSteps: 8, tokenBudget: 40_000, readTopK: 2, searchResultsPerQuery: 5 },
  standard: {},
  deep: { maxSteps: 36, tokenBudget: 200_000, readTopK: 4, searchResultsPerQuery: 8 },
}

export function resolveConfig(
  base: Partial<DeepSearchConfig>,
  depth?: ResearchDepth
): Partial<DeepSearchConfig> {
  // Explicit per-plugin config wins over the depth preset.
  return { ...DEPTH_PRESETS[depth ?? "standard"], ...base }
}

/** The declarative definition, also mirrored in `plugin.json` for discovery. */
export const DEEP_RESEARCH_TOOL = defineTool({
  name: "deep_research",
  description:
    "Run an autonomous web research loop (search → read → reason → cited answer) " +
    "for a multi-hop or knowledge-intensive question. mode='search' returns a " +
    "grounded cited answer; mode='report' returns a multi-section cited report. " +
    "Use for questions that need current web evidence.",
  parametersSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The research question or report topic." },
      mode: {
        type: "string",
        enum: ["search", "report"],
        description: "'search' for a cited answer (default), 'report' for a multi-section report.",
      },
      depth: {
        type: "string",
        enum: ["quick", "standard", "deep"],
        description: "How exhaustively to research (default: standard).",
      },
    },
    required: ["query"],
  },
})

export function registerDeepResearchTool(ctx: PluginContext): void {
  ctx.agent.registerTool({
    name: DEEP_RESEARCH_TOOL.name,
    pluginId: ctx.pluginId,
    definition: DEEP_RESEARCH_TOOL,
    execute: (args, toolCtx) => runResearchTool(ctx, (args ?? {}) as ResearchToolArgs, toolCtx),
  })
}

export async function runResearchTool(
  ctx: PluginContext,
  args: ResearchToolArgs,
  toolCtx?: PluginToolContext
): Promise<unknown> {
  const query = (args.query ?? "").trim()
  if (!query) return { ok: false as const, error: "query is required" }

  const deps = buildEngineDeps(ctx, {
    ...(toolCtx?.reportProgress ? { reportProgress: toolCtx.reportProgress } : {}),
    ...(toolCtx?.signal ? { signal: toolCtx.signal } : {}),
    // The tool call's own session — the host routes model + web calls with it,
    // and on a multi-session host there is nothing ambient to fall back on.
    ...(toolCtx?.sessionId ? { sessionId: toolCtx.sessionId } : {}),
  })
  const config = resolveConfig(readEngineConfig(ctx), args.depth)

  try {
    if (args.mode === "report") {
      const report = await runDeepResearch(query, deps, config)
      return {
        ok: true as const,
        mode: "report" as const,
        title: report.title,
        report: report.report,
        citations: report.citations,
        sections: report.sections.length,
        tokens: report.usage.totalTokens,
      }
    }

    const result = await runDeepSearch(query, deps, config)
    return {
      ok: true as const,
      mode: "search" as const,
      answer: result.answer,
      citations: result.citations,
      gaveUp: result.gaveUp,
      steps: result.steps.length,
      tokens: result.usage.totalTokens,
    }
  } catch (err) {
    // Classified rather than raw: the model reads this string, and "no search
    // provider configured" is actionable where a stack-shaped message is not.
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false as const, error: errorText(classifyResearchError(err), detail) }
  }
}

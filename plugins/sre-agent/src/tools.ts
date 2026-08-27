import type { PluginTool, PluginToolContext, PluginToolDef } from "@/types/plugin"
import manifestJson from "../plugin.json"
import type { SreTimelineDraft, SreValidationResult } from "./evidence"
import type { SrePluginContext } from "./runtime"
import { createSreRuntime, type SreRuntime } from "./runtime"
import { notifySreToolActivity } from "./panel-runtime"

const TOOL_DEFINITIONS = manifestJson.tools as PluginToolDef[]

/** Tool names declared by the install-time manifest. */
export const SRE_TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name)

export type SreToolName = (typeof SRE_TOOL_NAMES)[number]

function assertActive(toolCtx: PluginToolContext, lifecycleSignal?: AbortSignal): void {
  if (lifecycleSignal?.aborted || toolCtx.signal?.aborted) {
    throw new Error("sre tool execution aborted")
  }
}

/**
 * Bind executable handlers to the declarative tool contracts in plugin.json.
 *
 * `runtime` is injectable so `activate()` can hand the tools the SAME instance
 * the panel reads. They share one evidence pool by design: the validator only
 * accepts ids that pool holds.
 */
export function createSreTools(
  ctx: SrePluginContext,
  lifecycleSignal?: AbortSignal,
  runtime: SreRuntime = createSreRuntime(ctx)
): PluginTool[] {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    sre_query_logs: (args) =>
      runtime.queryLogs(args as unknown as Parameters<typeof runtime.queryLogs>[0]),
    sre_query_trace: (args) =>
      runtime.queryTrace(args as unknown as Parameters<typeof runtime.queryTrace>[0]),
    sre_query_metrics: (args) =>
      runtime.queryMetrics(args as unknown as Parameters<typeof runtime.queryMetrics>[0]),
    sre_validate_timeline: (args) => runtime.validateTimeline(args as unknown as SreTimelineDraft),
  }

  return TOOL_DEFINITIONS.map((definition) => {
    const handler = handlers[definition.name]
    if (!handler) throw new Error(`missing SRE tool handler: ${definition.name}`)
    return {
      name: definition.name,
      pluginId: ctx.pluginId,
      definition,
      execute: async (args, toolCtx) => {
        assertActive(toolCtx, lifecycleSignal)
        const result = await handler(args)
        publishActivity(definition.name, args, result)
        return result
      },
    }
  })
}

/**
 * Tell the panel what the agent just fetched.
 *
 * Queries publish their evidence ids. Timeline validation also publishes the
 * exact draft and verdict so the panel can offer them for explicit adoption.
 */
function publishActivity(tool: string, args: Record<string, unknown>, result: unknown): void {
  if (tool === "sre_validate_timeline") {
    notifySreToolActivity({
      tool,
      evidenceIds: [],
      at: new Date().toISOString(),
      timelineDraft: args as unknown as SreTimelineDraft,
      validation: result as SreValidationResult,
    })
    return
  }
  const evidenceIds = (result as { evidenceIds?: unknown } | null)?.evidenceIds
  if (!Array.isArray(evidenceIds)) return
  notifySreToolActivity({
    tool,
    evidenceIds: evidenceIds.filter((id): id is string => typeof id === "string"),
    at: new Date().toISOString(),
  })
}

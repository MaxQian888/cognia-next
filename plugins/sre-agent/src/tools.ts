import type { PluginTool, PluginToolContext, PluginToolDef } from "@/types/plugin"
import manifestJson from "../plugin.json"
import type { SreTimelineDraft } from "./evidence"
import type { SrePluginContext } from "./runtime"
import { createSreRuntime } from "./runtime"

const TOOL_DEFINITIONS = manifestJson.tools as PluginToolDef[]

/** Tool names declared by the install-time manifest. */
export const SRE_TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name)

export type SreToolName = (typeof SRE_TOOL_NAMES)[number]

function assertActive(toolCtx: PluginToolContext, lifecycleSignal?: AbortSignal): void {
  if (lifecycleSignal?.aborted || toolCtx.signal?.aborted) {
    throw new Error("sre tool execution aborted")
  }
}

/** Bind executable handlers to the declarative tool contracts in plugin.json. */
export function createSreTools(ctx: SrePluginContext, lifecycleSignal?: AbortSignal): PluginTool[] {
  const runtime = createSreRuntime(ctx)
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
        return handler(args)
      },
    }
  })
}

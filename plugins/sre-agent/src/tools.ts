import {
  definePluginTool,
  type PluginToolContext,
  type PluginToolDef,
  type PluginToolRegistration,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import type { SreTimelineDraft, SreValidationResult } from "./evidence"
import type { SreLogFilter, SreMetricFilter, SreTraceFilter } from "./providers/types"
import { createSreRuntime, type SreRuntime } from "./runtime"
import { notifySreToolActivity } from "./panel-runtime"

const TOOL_DEFINITIONS: PluginToolDef[] = manifestJson.tools

/** Tool names declared by the install-time manifest. */
export const SRE_TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name)

export type SreToolName = (typeof SRE_TOOL_NAMES)[number]

function assertActive(toolCtx: PluginToolContext, lifecycleSignal?: AbortSignal): void {
  if (lifecycleSignal?.aborted || toolCtx.signal?.aborted) {
    throw new Error("sre tool execution aborted")
  }
}

/*
 * The tool arguments arrive as the JSON the model produced, already checked
 * against the manifest's `parametersSchema`. The runtime re-validates every
 * field it relies on (its error strings are the tool contract), so these
 * narrowings only restate the schema for TypeScript.
 */
const asLogFilter = (args: Record<string, unknown>) => args as Partial<SreLogFilter> as SreLogFilter
const asTraceFilter = (args: Record<string, unknown>) =>
  args as Partial<SreTraceFilter> as SreTraceFilter
const asMetricFilter = (args: Record<string, unknown>) =>
  args as Partial<SreMetricFilter> as SreMetricFilter
const asTimelineDraft = (args: Record<string, unknown>) =>
  args as Partial<SreTimelineDraft> as SreTimelineDraft

/**
 * Bind executable handlers to the declarative tool contracts in plugin.json.
 *
 * `runtime` is shared with the panel by `activate()`. They share one evidence
 * pool by design: the validator only accepts ids that pool holds. Every query
 * result carries `dataSource` (and, for the bundled demo corpus, a `notice`),
 * so the agent cannot mistake demo records for the user's systems.
 */
export function createSreTools(
  runtime: SreRuntime = createSreRuntime(),
  lifecycleSignal?: AbortSignal
): PluginToolRegistration[] {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    sre_query_logs: (args) => runtime.queryLogs(asLogFilter(args)),
    sre_query_trace: (args) => runtime.queryTrace(asTraceFilter(args)),
    sre_query_metrics: (args) => runtime.queryMetrics(asMetricFilter(args)),
    sre_validate_timeline: (args) => runtime.validateTimeline(asTimelineDraft(args)),
  }

  return TOOL_DEFINITIONS.map((definition) => {
    const handler = handlers[definition.name]
    if (!handler) throw new Error(`missing SRE tool handler: ${definition.name}`)
    return definePluginTool({
      name: definition.name,
      definition,
      execute: async (args, toolCtx) => {
        assertActive(toolCtx, lifecycleSignal)
        const result = await handler(args)
        publishActivity(definition.name, args, result)
        return result
      },
    })
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
      timelineDraft: asTimelineDraft(args),
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

/**
 * Pure trace summarization for the annotation panel: fold the flat
 * `agentTraces` spans into one row per trace (newest-first) with the tool
 * sequence and a short preview, so the "look at your data" panel can render a
 * scannable list without re-querying per trace.
 */

import type { AgentTraceSpan } from "@/types/agent-trace/span"

export interface TraceSummary {
  traceId: string
  sessionId: string
  startTime: number
  /** Tool names in invocation order. */
  toolNames: string[]
  /** Short text preview (first available input/output preview). */
  preview: string
}

export function summarizeTraces(spans: AgentTraceSpan[]): TraceSummary[] {
  const byTrace = new Map<string, AgentTraceSpan[]>()
  for (const s of spans) {
    const list = byTrace.get(s.traceId) ?? []
    list.push(s)
    byTrace.set(s.traceId, list)
  }

  const summaries: TraceSummary[] = []
  for (const [traceId, group] of byTrace) {
    const ordered = [...group].sort((a, b) => a.startTime - b.startTime)
    const toolNames = ordered
      .filter((s) => s.operationName === "execute_tool" && s.toolName)
      .map((s) => s.toolName as string)
    const previewSpan = ordered.find((s) => s.inputPreview) ?? ordered.find((s) => s.outputPreview)
    summaries.push({
      traceId,
      sessionId: ordered[0]?.sessionId ?? "",
      startTime: ordered[0]?.startTime ?? 0,
      toolNames,
      preview: previewSpan?.inputPreview ?? previewSpan?.outputPreview ?? "",
    })
  }

  return summaries.sort((a, b) => b.startTime - a.startTime)
}

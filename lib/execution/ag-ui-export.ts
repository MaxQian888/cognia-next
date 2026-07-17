import type { RunEvent } from "@/types/execution/run"

export type AgUiExportEvent =
  | { type: "RUN_STARTED"; threadId: string; runId: string; timestamp: number }
  | { type: "RUN_FINISHED"; threadId: string; runId: string; timestamp: number; result?: unknown }
  | { type: "RUN_ERROR"; message: string; code?: string; timestamp: number }
  | { type: "STATE_SNAPSHOT"; snapshot: Record<string, unknown>; timestamp: number }
  | { type: "STATE_DELTA"; delta: Record<string, unknown>; timestamp: number }
  | { type: "STEP_STARTED" | "STEP_FINISHED"; stepName: string; timestamp: number }
  | {
      type: "TOOL_CALL_START"
      toolCallId: string
      toolCallName: string
      timestamp: number
    }
  | { type: "TOOL_CALL_END"; toolCallId: string; timestamp: number }
  | {
      type: "TOOL_CALL_RESULT"
      messageId: string
      toolCallId: string
      content: string
      role: "tool"
      timestamp: number
    }

function text(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Read-only AG-UI compatibility projection. Deliberately exports semantic
 * summaries only: private events, reasoning, tool arguments, and raw results
 * have no mapping.
 */
export function runEventsToAgUi(threadId: string, events: readonly RunEvent[]): AgUiExportEvent[] {
  const out: AgUiExportEvent[] = []
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.visibility === "private") continue
    switch (event.type) {
      case "run.started":
        out.push({
          type: "RUN_STARTED",
          threadId,
          runId: event.runId,
          timestamp: event.ts,
        })
        break
      case "run.completed":
        out.push({
          type: "RUN_FINISHED",
          threadId,
          runId: event.runId,
          timestamp: event.ts,
          ...(text(event.payload, "summary")
            ? { result: { summary: text(event.payload, "summary") } }
            : {}),
        })
        break
      case "run.cancelled":
        out.push({
          type: "RUN_FINISHED",
          threadId,
          runId: event.runId,
          timestamp: event.ts,
          result: { status: "cancelled" },
        })
        break
      case "run.failed":
        out.push({
          type: "RUN_ERROR",
          message: text(event.payload, "error") ?? "Run failed",
          ...(text(event.payload, "code") ? { code: text(event.payload, "code") } : {}),
          timestamp: event.ts,
        })
        break
      case "step.started":
        out.push({
          type: "STEP_STARTED",
          stepName: text(event.payload, "title") ?? text(event.payload, "stepId") ?? "Step",
          timestamp: event.ts,
        })
        break
      case "plan.created":
      case "plan.revised":
        out.push({
          type: "STATE_SNAPSHOT",
          snapshot: {
            plan: {
              version: event.payload.version,
              steps: event.payload.steps,
            },
          },
          timestamp: event.ts,
        })
        break
      case "step.added":
      case "step.progress":
      case "interrupt.requested":
      case "interrupt.resolved":
      case "interrupt.expired":
        out.push({
          type: "STATE_DELTA",
          delta: { event: event.type, payload: event.payload },
          timestamp: event.ts,
        })
        break
      case "step.completed":
      case "step.failed":
      case "step.skipped":
        out.push({
          type: "STEP_FINISHED",
          stepName: text(event.payload, "title") ?? text(event.payload, "stepId") ?? "Step",
          timestamp: event.ts,
        })
        break
      case "tool.started": {
        const toolCallId = text(event.payload, "toolCallId")
        const toolName = text(event.payload, "toolName")
        if (toolCallId && toolName) {
          out.push({
            type: "TOOL_CALL_START",
            toolCallId,
            toolCallName: toolName,
            timestamp: event.ts,
          })
        }
        break
      }
      case "tool.completed":
      case "tool.failed": {
        const toolCallId = text(event.payload, "toolCallId")
        if (!toolCallId) break
        out.push({ type: "TOOL_CALL_END", toolCallId, timestamp: event.ts })
        out.push({
          type: "TOOL_CALL_RESULT",
          messageId: event.id,
          toolCallId,
          content:
            text(event.payload, "summary") ??
            (event.type === "tool.failed" ? "Tool failed" : "Tool completed"),
          role: "tool",
          timestamp: event.ts,
        })
        break
      }
      default:
        break
    }
  }
  return out
}

/**
 * Translates a `CaptureStreamEvent` (from `runAndCaptureAssistantReply`'s
 * `onEvent` seam) into reducer actions. Kept pure so the wiring is unit-tested
 * without a live session.
 */
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

import type { TuiAction } from "./types"

/** Stable correlation key for a tool call (tool name + serialized input). */
export function toolCallKey(toolName: string, input: Record<string, unknown>): string {
  let serialized = ""
  try {
    serialized = JSON.stringify(input)
  } catch {
    serialized = ""
  }
  return `${toolName}:${serialized}`
}

export function captureEventToActions(event: CaptureStreamEvent): TuiAction[] {
  switch (event.type) {
    case "text-delta":
      return event.delta.length > 0 ? [{ type: "INFLIGHT_TEXT", delta: event.delta }] : []
    case "thinking-delta":
      return event.delta.length > 0 ? [{ type: "INFLIGHT_THINKING", delta: event.delta }] : []
    case "tool-call":
      return [
        {
          type: "TOOL_CALL",
          callKey: toolCallKey(event.toolName, event.input),
          toolName: event.toolName,
          input: event.input,
        },
      ]
    case "tool-result":
      return [
        {
          type: "TOOL_RESULT",
          toolName: event.toolName,
          ...(event.input ? { input: event.input } : {}),
          result: event.result,
          ...(event.isError ? { isError: true } : {}),
        },
      ]
    default:
      return []
  }
}

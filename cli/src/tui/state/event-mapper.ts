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
          // When the result carries its originating input, derive the same
          // callKey the TOOL_CALL used so the reducer can pair them exactly.
          ...(event.input
            ? { input: event.input, callKey: toolCallKey(event.toolName, event.input) }
            : {}),
          result: event.result,
          ...(event.isError ? { isError: true } : {}),
        },
      ]
    case "usage":
      return [{ type: "SET_USAGE", usage: event.usage }]
    case "compact":
      return [
        {
          type: "COMPACT_BOUNDARY",
          trigger: event.trigger,
          preTokens: event.preTokens,
          postTokens: event.postTokens,
        },
      ]
    default:
      return []
  }
}

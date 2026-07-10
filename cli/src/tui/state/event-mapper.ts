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
          // Prefer the SDK's stable `tool_use` id: it pairs a result exactly and,
          // unlike name+input, keeps two concurrent calls with identical args
          // distinct. Fall back to name+input when the provider gives no id.
          callKey: event.id ?? toolCallKey(event.toolName, event.input),
          toolName: event.toolName,
          input: event.input,
        },
      ]
    case "tool-result": {
      // Same correlation key the TOOL_CALL used, so the reducer pairs them
      // exactly: the `tool_use_id` when present, else name+input when the result
      // carries its originating input. Absent both ⇒ no callKey (nameless result).
      const callKey =
        event.id ?? (event.input ? toolCallKey(event.toolName, event.input) : undefined)
      return [
        {
          type: "TOOL_RESULT",
          toolName: event.toolName,
          ...(event.input ? { input: event.input } : {}),
          ...(callKey ? { callKey } : {}),
          result: event.result,
          ...(event.isError ? { isError: true } : {}),
        },
      ]
    }
    case "usage":
      // Skip mid-run partial snapshots (non-cumulative); the footer shows the
      // authoritative end-of-turn usage only.
      if (event.partial) return []
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

/**
 * External-agent event → `CaptureStreamEvent` bridge.
 *
 * The built-in `runtime:"claude"` channel streams live progress by emitting
 * `CaptureStreamEvent`s (the sidecar capture-loop shape) into the teammate
 * progress reporter (`teammate-progress-coalescer.ts`) and the subagent runtime
 * store. The external-CLI channel speaks the richer `ExternalAgentEvent`
 * protocol instead, so `runExternalBacked` / `runExternalSubagent` used to
 * surface only start/terminal markers — no live tool-calls or streamed text.
 *
 * This translator maps the subset of `ExternalAgentEvent`s that carry visible
 * progress (assistant text, thinking, tool boundaries) onto `CaptureStreamEvent`,
 * so an external teammate/subagent lights up the SAME activity UI as a built-in
 * one with zero new rendering code. Lifecycle / permission / plan / mode / config
 * / done / error events map to `[]` — the reporter owns terminal framing via its
 * own `finalize()`, and permission/hook notices already flow through the
 * manager's dedicated channels.
 *
 * Pure and dependency-free (a single `switch`), so it is trivially unit-testable
 * and safe to call from either dispatch path.
 */

import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import type { ExternalAgentEvent } from "@/types/agent/external-agent"

/**
 * Translate one `ExternalAgentEvent` into zero or more `CaptureStreamEvent`s.
 * Returns `[]` for events that carry no incremental progress.
 */
export function externalEventToCaptureEvents(event: ExternalAgentEvent): CaptureStreamEvent[] {
  switch (event.type) {
    case "message_delta": {
      // Streamed assistant output. `thinking` deltas are reasoning; the rest is
      // visible answer text (charCount in the reporter).
      const text = event.delta?.text
      if (!text) return []
      return event.delta.type === "thinking"
        ? [{ type: "thinking-delta", delta: text }]
        : [{ type: "text-delta", delta: text }]
    }
    case "thinking": {
      return event.thinking ? [{ type: "thinking-delta", delta: event.thinking }] : []
    }
    case "commentary_delta": {
      return [
        {
          type: "commentary-delta",
          delta: event.text,
          ...(event.messageId ? { messageId: event.messageId } : {}),
          ...(typeof event.done === "boolean" ? { done: event.done } : {}),
        },
      ]
    }
    case "tool_use_start": {
      // One tool boundary per tool call — paired with the later `tool_result`
      // by `toolUseId`. `tool_use_delta` (partial arg streaming) and
      // `tool_use_end` are intentionally skipped so a call is counted once.
      return [
        {
          type: "tool-call",
          toolName: event.toolName,
          input: event.rawInput ?? {},
          id: event.toolUseId,
        },
      ]
    }
    case "tool_result": {
      return [
        {
          type: "tool-result",
          toolName: event.toolName ?? "tool",
          id: event.toolUseId,
          ...(event.rawInput ? { input: event.rawInput } : {}),
          result: event.result,
          ...(typeof event.isError === "boolean" ? { isError: event.isError } : {}),
        },
      ]
    }
    default:
      return []
  }
}

/**
 * Adapt an external-agent `onEvent` sink so it forwards translated
 * `CaptureStreamEvent`s to a `CaptureStreamEvent` consumer (the progress reporter
 * or the subagent runtime store). A throwing consumer is swallowed — a broken
 * progress sink must never fail the underlying dispatch.
 */
export function pipeExternalEventsToCapture(
  onCapture: (event: CaptureStreamEvent) => void
): (event: ExternalAgentEvent) => void {
  return (event) => {
    for (const mapped of externalEventToCaptureEvents(event)) {
      try {
        onCapture(mapped)
      } catch {
        // Best-effort progress: never let a sink error escape into the dispatch.
      }
    }
  }
}

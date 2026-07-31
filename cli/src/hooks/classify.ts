/**
 * Pure classification of CLI `CaptureStreamEvent`s into hook lifecycle events.
 *
 * Ported from the relevant arms of `src-tauri/src/hooks/classify.rs`, but against
 * the CLI's `CaptureStreamEvent` shape (from `lib/claude/run-and-capture`) rather
 * than the raw SDK/sidecar `Value`. The CLI stream surfaces a much smaller set of
 * events than the desktop sidecar reader, so only a few map to a hook:
 *
 *   - `tool-result` → PostToolUse   (carries the tool name in `fields`)
 *   - `compact`     → PostCompact   (carries trigger + token deltas)
 *   - `tool-call`   → null          (PreToolUse is fired by the turn engine
 *                                     BEFORE dispatch, not from the capture tap)
 *   - `text-delta` / `thinking-delta` / `usage` → null
 *
 * Everything here is a pure function of its input so it is exhaustively
 * unit-testable. Returns `null` for events that imply no hook.
 */
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

import type { HookEvent } from "./types"

/** A classified hook + the free-form payload fields the handler receives. */
export interface ClassifiedHook {
  event: HookEvent
  fields: Record<string, unknown>
}

/**
 * Map a single {@link CaptureStreamEvent} onto the hook it implies, or `null`
 * when the event produces no hook.
 */
export function classifyEvent(ev: CaptureStreamEvent): ClassifiedHook | null {
  switch (ev.type) {
    case "tool-result":
      return {
        event: "PostToolUse",
        fields: {
          tool_name: ev.toolName,
          ...(ev.input ? { tool_input: ev.input } : {}),
          tool_result: ev.result,
          is_error: ev.isError === true,
        },
      }
    case "compact":
      return {
        event: "PostCompact",
        fields: {
          trigger: ev.trigger,
          pre_tokens: ev.preTokens,
          post_tokens: ev.postTokens,
        },
      }
    // No hook: partial-assistant deltas and per-turn usage carry no lifecycle
    // signal, and a `tool-call` is pre-dispatch (PreToolUse is fired by the
    // turn engine around the actual tool invocation, not from this tap).
    case "text-delta":
    case "thinking-delta":
    case "tool-call":
    case "usage":
      return null
    default:
      return null
  }
}

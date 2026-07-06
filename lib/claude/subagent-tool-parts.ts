/**
 * Pure mapper turning a sub-agent's live {@link SubAgentToolCall}s into the
 * `ToolUIPart` entries consumed by `ToolActivityGroup` / `ToolCallRow`, so the
 * inline tool list under an expanded `SubagentPart` reuses the exact same
 * rendering as the main chat's tool flow.
 *
 * Mirrors the state mapping in `lib/ai/agent/external/event-to-parts.ts`:
 *   running → input-available, done → output-available, error → output-error.
 */

import type { ToolUIPart } from "ai"
import type { SubAgentToolCall } from "@/types/agent/sub-agent"
import type { ToolActivityGroupEntry } from "@/components/chat/message-parts/tool-activity-group"

function stateFor(call: SubAgentToolCall): ToolUIPart["state"] {
  if (call.state === "running") return "input-available"
  if (call.state === "error") return "output-error"
  return "output-available"
}

function errorTextOf(output: unknown): string | undefined {
  if (output == null) return undefined
  if (typeof output === "string") return output
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

export function toToolActivityEntries(
  toolCalls: readonly SubAgentToolCall[] | undefined
): ToolActivityGroupEntry[] {
  if (!toolCalls || toolCalls.length === 0) return []
  return toolCalls.map((call) => {
    const part = {
      type: `tool-${call.name}`,
      toolCallId: call.id,
      state: stateFor(call),
      input: call.input ?? {},
      ...(call.output !== undefined ? { output: call.output } : {}),
      ...(call.state === "error" ? { errorText: errorTextOf(call.output) } : {}),
    } as unknown as ToolUIPart
    return { part, key: call.id }
  })
}

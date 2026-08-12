"use client"

import { COMPUTER_USE_PLUGIN_TOOL_NAMES } from "@/lib/claude/computer-use-tools"
import { setToolSpanEventPublisher } from "@cognia/agent-trace/chat-tool-spans"
import { emitSystemBusEvent } from "@/lib/plugin/messaging/message-bus"

// ADR-0020 W3 — keep grant recording and send-side suppression on the
// same visual/execution tool-name contract.
export const COMPUTER_USE_PLUGIN_TOOL_NAME_SET = new Set<string>(COMPUTER_USE_PLUGIN_TOOL_NAMES)

export function isComputerUsePluginToolName(name: string): boolean {
  return COMPUTER_USE_PLUGIN_TOOL_NAME_SET.has(name)
}

setToolSpanEventPublisher((eventType, payload) => {
  emitSystemBusEvent(eventType, payload)
})

// ── Plugin tool hooks (W3.1) ─────────────────────────────────────────────────
// Correlates `tool_result_review` events back to the tool call's name + input
// so `dispatchPostToolUse` receives real args. Fed from streamed assistant
// `tool_use` blocks and from `permission_request` events; bounded so a long
// session can't grow it unboundedly.
export const chatToolCallsById = new Map<string, { name: string; input: Record<string, unknown> }>()

export const behaviorTurnStartedAt = new Map<string, number>()

export function finishBehaviorTurn(sessionId: string): number | undefined {
  const startedAt = behaviorTurnStartedAt.get(sessionId)
  if (startedAt === undefined) return undefined
  behaviorTurnStartedAt.delete(sessionId)
  return Math.max(0, Date.now() - startedAt)
}

export const CHAT_TOOL_CALLS_CAP = 500

export function rememberChatToolCall(
  id: string,
  name: string,
  input: Record<string, unknown>
): void {
  if (!id) return
  if (chatToolCallsById.size >= CHAT_TOOL_CALLS_CAP) {
    const oldest = chatToolCallsById.keys().next().value
    if (oldest !== undefined) chatToolCallsById.delete(oldest)
  }
  chatToolCallsById.set(id, { name, input })
}

/** Pull assistant `tool_use` blocks out of a streamed SDK event envelope. */
export function rememberToolCallsFromSdkEvent(event: unknown): void {
  const message = (event as { message?: { content?: unknown } } | undefined)?.message
  const content = message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    const b = block as { type?: string; id?: string; name?: string; input?: unknown }
    if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      rememberChatToolCall(b.id, b.name, (b.input as Record<string, unknown>) ?? {})
    }
  }
}

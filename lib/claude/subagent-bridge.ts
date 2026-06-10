// Bridge between the SubAgent runtime store (producer) and assistant
// UIMessage parts (consumer / renderer).
//
// Phase 8 of the ClaudeCode 完整化 plan. The adapter is intentionally pure
// (no React or store subscription); the chat hook (`use-claude-chat.ts`)
// subscribes to `useSubagentRuntimeStore` and feeds events into
// `applySubagentUpdate`. That keeps `lib/claude/adapter.ts` independent of
// runtime UI concerns.

import type { UIMessage } from "ai"
import type { SubAgent } from "@/types/agent/sub-agent"
import type { SubagentPart } from "./parts-extensions"
import { isSubagentPart } from "./parts-extensions"

/**
 * Find or insert a `SubagentPart` on the assistant message that spawned
 * this sub-agent. We match by:
 *   1. `parentMessageId` (preferred — exact assistant turn)
 *   2. `parentAgentId` falling back to the most-recent assistant message
 *
 * Idempotent: replaying the same `SubAgent` snapshot after the part was
 * already inserted just patches the existing entry in place.
 */
export function applySubagentUpdate(
  messages: UIMessage[],
  subAgent: SubAgent,
  opts?: { parentMessageId?: string }
): UIMessage[] {
  const part: SubagentPart = {
    type: "subagent",
    subagentId: subAgent.id,
    parentSessionId: (subAgent.context?.sessionId as string | undefined) ?? subAgent.parentAgentId,
    name: subAgent.name,
    status: subAgent.status,
    progress: subAgent.progress,
    startedAt:
      subAgent.startedAt instanceof Date
        ? subAgent.startedAt.getTime()
        : subAgent.createdAt instanceof Date
          ? subAgent.createdAt.getTime()
          : Date.now(),
    completedAt: subAgent.completedAt instanceof Date ? subAgent.completedAt.getTime() : undefined,
    summary: subAgent.result?.finalResponse,
    ...(typeof subAgent.depth === "number" ? { depth: subAgent.depth } : {}),
    ...(subAgent.parentSubagentId ? { parentSubagentId: subAgent.parentSubagentId } : {}),
    ...(subAgent.result?.tokenUsage ? { tokenUsage: subAgent.result.tokenUsage } : {}),
    ...(subAgent.rejection
      ? { rejection: { reason: subAgent.rejection.reason, message: subAgent.rejection.message } }
      : {}),
    ...(subAgent.backgrounded ? { backgrounded: true } : {}),
  }

  const targetIdx = pickTargetMessageIndex(messages, opts?.parentMessageId, subAgent.parentAgentId)
  if (targetIdx === -1) return messages // nothing to attach to

  const target = messages[targetIdx]
  const existing = (target.parts ?? []) as unknown[]
  let replaced = false
  const nextParts: unknown[] = []
  for (const p of existing) {
    if (isSubagentPart(p) && p.subagentId === subAgent.id) {
      nextParts.push(part)
      replaced = true
    } else {
      nextParts.push(p)
    }
  }
  if (!replaced) nextParts.push(part)

  const out = messages.slice()
  out[targetIdx] = {
    ...target,
    parts: nextParts as unknown as UIMessage["parts"],
  }
  return out
}

function pickTargetMessageIndex(
  messages: UIMessage[],
  parentMessageId: string | undefined,
  parentAgentId: string
): number {
  if (parentMessageId) {
    const idx = messages.findIndex((m) => m.id === parentMessageId)
    if (idx !== -1) return idx
  }

  // First pass: look for an assistant whose metadata names the parent agent.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    const metaParent = (msg as unknown as { metadata?: { parentAgentId?: string } }).metadata
      ?.parentAgentId
    if (metaParent === parentAgentId) return i
  }

  // Fallback: most recent assistant.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return i
  }
  return -1
}

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
const TERMINAL_STATUSES: ReadonlySet<SubAgent["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "rejected",
])

export function applySubagentUpdate(
  messages: UIMessage[],
  subAgent: SubAgent,
  opts?: { parentMessageId?: string }
): UIMessage[] {
  // gap7: freeze the live tool list / logs / final response onto the part ONLY
  // on a terminal transition. The runtime store is ephemeral, so without this
  // snapshot a completed run's expanded tree vanishes on reload. We must NOT
  // write these on every running tick — `subagentSignature` already changes on
  // the terminal transition, so this piggybacks on one already-occurring
  // message-array rewrite instead of churning on each tool event.
  const isTerminal = TERMINAL_STATUSES.has(subAgent.status)
  const terminalSnapshot = isTerminal
    ? {
        ...(subAgent.toolCalls?.length ? { toolCalls: subAgent.toolCalls } : {}),
        ...(subAgent.logs?.length
          ? {
              logs: subAgent.logs.map((l) => ({
                level: l.level,
                message: l.message,
                ...(l.data !== undefined ? { data: l.data } : {}),
              })),
            }
          : {}),
        ...(subAgent.result?.finalResponse ? { finalResponse: subAgent.result.finalResponse } : {}),
        ...(typeof subAgent.toolUses === "number" ? { toolUses: subAgent.toolUses } : {}),
      }
    : {}

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
    ...terminalSnapshot,
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

/**
 * Select the SubAgents belonging to a chat session: the roots dispatched
 * directly by that session (`context.sessionId === sessionId`) plus their
 * transitive descendants linked by `parentSubagentId`. Nested (depth ≥ 2)
 * subagents carry the ephemeral executor session id rather than the chat
 * session id, so they must be pulled in via tree reachability — otherwise the
 * rendered tree would be truncated at depth 1.
 */
export function selectSessionSubagents(
  subAgents: Record<string, SubAgent>,
  sessionId: string
): SubAgent[] {
  const all = Object.values(subAgents)
  const rootIds = new Set(all.filter((s) => s.context?.sessionId === sessionId).map((s) => s.id))
  if (rootIds.size === 0) return []

  // Expand to transitive descendants via parentSubagentId until the set is stable.
  const included = new Set(rootIds)
  let grew = true
  while (grew) {
    grew = false
    for (const s of all) {
      if (included.has(s.id)) continue
      if (s.parentSubagentId && included.has(s.parentSubagentId)) {
        included.add(s.id)
        grew = true
      }
    }
  }
  return all.filter((s) => included.has(s.id))
}

/** Fold `applySubagentUpdate` over many subagents. Returns the same ref if no change. */
export function applySubagentsToMessages(messages: UIMessage[], subs: SubAgent[]): UIMessage[] {
  let out = messages
  for (const sub of subs) out = applySubagentUpdate(out, sub)
  return out
}

/**
 * Cheap change-signature for a set of subagents — id/status/summary-presence.
 * The chat-side subscriber compares this against the last applied value so a
 * no-op subagent-store mutation doesn't trigger a redundant message rewrite.
 *
 * `progress` is deliberately EXCLUDED: the chat transcript card renders the live
 * tool-use count (read directly from the store per-card), never a progress
 * percentage, so a progress tick has no transcript effect — including it here
 * would rewrite the whole message array (full `MessageRenderer` re-render) for
 * nothing. `toolUses`/`logs` are likewise excluded for the same reason.
 */
export function subagentSignature(subs: SubAgent[]): string {
  return subs
    .map((s) => `${s.id}:${s.status}:${s.result?.finalResponse ? 1 : 0}`)
    .sort()
    .join("|")
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

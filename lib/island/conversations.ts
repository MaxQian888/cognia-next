/**
 * Which Cognia conversations the island's inputs mention, and what the main
 * window knows about each — the `conversations` input of the projection.
 *
 * Pure: the initializer supplies the chat store's statuses and the session
 * rows it read, and this module decides. A session id counts as a conversation
 * only when a visible chat row proves it; an ephemeral subagent session, an IM
 * job's session or an embedded workbench session stays a run.
 */

import type { ChatSession } from "@cognia/agent-config-types"

import type { AttentionItem } from "@/lib/attention/types"
import type { FleetSnapshot } from "@/lib/fleet/types"
import type { IslandConversationFacts } from "./projection"

type ChatStatus = NonNullable<IslandConversationFacts["status"]>

const CHAT_STATUSES: readonly ChatStatus[] = ["idle", "streaming", "awaiting_approval", "error"]

/**
 * Every session id that could be a conversation: each Cognia run's session (a
 * chat turn runs in its conversation's own session) and each chat approval's
 * conversation. Sorted and unique, so it can key a query.
 */
export function conversationCandidates(
  fleet: FleetSnapshot,
  attention: readonly AttentionItem[]
): string[] {
  const ids = new Set<string>()
  for (const session of fleet.sessions) {
    if (session.agent === "cognia" && session.sessionId) ids.add(session.sessionId)
  }
  for (const item of attention) {
    if (item.source === "chat" && item.sessionId) ids.add(item.sessionId)
  }
  return [...ids].sort()
}

/** A chat store status, or `null` when the store holds no slice for it. */
export function chatStatusOf(status: string | undefined): ChatStatus | null {
  return CHAT_STATUSES.includes(status as ChatStatus) ? (status as ChatStatus) : null
}

/**
 * Facts for the candidates a session row proves are conversations.
 *
 * `direct` holds for ordinary chats only (a row written before `kind` existed
 * is one): team rooms and workbench sessions run on engines the chat
 * runtime's Stop and send do not drive.
 */
export function conversationFacts(
  statuses: Readonly<Record<string, ChatStatus | null>>,
  sessions: readonly ChatSession[]
): Record<string, IslandConversationFacts> {
  const facts: Record<string, IslandConversationFacts> = {}
  for (const session of sessions) {
    if (session.visibility === "embedded") continue
    facts[session.id] = {
      direct: session.kind === undefined || session.kind === "direct",
      status: statuses[session.id] ?? null,
      ...(session.title ? { title: session.title } : {}),
    }
  }
  return facts
}

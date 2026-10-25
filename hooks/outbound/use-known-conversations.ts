"use client"

/**
 * The IM conversations this device knows, for picking recipients (ADR-0239).
 *
 * A recipient list holds conversations by key, and a key alone reads as noise.
 * Every bound session carries its conversation's key and a title, so the
 * picker can offer chats by name. One entry per chat: threads and sessions of
 * the same chat collapse onto the chat a list entry names.
 */

import { useLiveQuery } from "dexie-react-hooks"

import { getDb } from "@/lib/db/schema"
import {
  conversationTarget,
  type OutboundTarget,
} from "@/lib/policy/action-review/outbound-targets"
import type { ChatSession } from "@cognia/agent-config-types"

export interface KnownConversation {
  /** The chat-level target a list entry names. */
  target: OutboundTarget
  /** The session's title, the closest thing to the chat's name. */
  title: string
  /** The newest activity, for ordering. */
  lastActivityAt: number
}

/** Pure: the chats these sessions are bound to, newest first. */
export function knownConversationsOf(
  sessions: readonly Pick<
    ChatSession,
    "title" | "platformBinding" | "lastMessageAt" | "updatedAt"
  >[],
  adapterId?: string
): KnownConversation[] {
  const byRecipient = new Map<string, KnownConversation>()
  for (const session of sessions) {
    const key = session.platformBinding?.conversationKey
    if (!key) continue
    const target = conversationTarget(key)
    if (!target || (adapterId && target.channel !== adapterId)) continue
    const lastActivityAt = session.lastMessageAt ?? session.updatedAt ?? 0
    const known = byRecipient.get(target.recipient)
    if (known && known.lastActivityAt >= lastActivityAt) continue
    byRecipient.set(target.recipient, {
      target,
      title: session.title?.trim() || key,
      lastActivityAt,
    })
  }
  return [...byRecipient.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
}

/** Live: the chats this device knows, optionally through one bot account. */
export function useKnownConversations(adapterId?: string): KnownConversation[] {
  return (
    useLiveQuery(async () => {
      const sessions = await getDb()
        .sessions.filter((session) => session.platformBinding != null)
        .toArray()
      return knownConversationsOf(sessions, adapterId)
    }, [adapterId]) ?? []
  )
}

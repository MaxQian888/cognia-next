"use client"

/**
 * Everything the Inbox triage pane shows about one session, read live.
 *
 * Loaded by session id rather than taken from the list's row: the preview can
 * be deep-linked (`?preview=`) to a session the current scope filters out, or
 * outlive its row (archived from another device). The reads are the same ones
 * the chat header makes — the session row, its override row, the resolved
 * trigger policy, the adapter config and the per-session unread state — so the
 * pane and the header never disagree about a conversation.
 *
 * Deliberately read-only. In particular it registers nothing with the
 * active-conversation store and marks nothing read: a preview is a glance, and
 * the bus must keep notifying (and the phone relay keep pushing) for a
 * conversation the user has not actually opened.
 */

import { useLiveQuery } from "dexie-react-hooks"
import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import { useAdapterInstance } from "@/hooks/connectors/use-adapter-instance"
import { useConversationOverride } from "@/hooks/connectors/use-conversation-overrides"
import { useResolvedBinding } from "@/hooks/connectors/use-resolved-binding"
import type { TriggerPolicy } from "@/types/connectors/policy"
import type { PlatformKind } from "@/types/connectors/platform-kind"

export interface TriageConversation {
  session: ChatSession
  conversationKey: string
  adapterId: string
  platform: PlatformKind
  override: ConversationOverrideRow | undefined
  /** `undefined` while loading or for an unknown adapter. */
  adapter: AdapterInstanceRow | undefined
  /** The resolved trigger policy; `undefined` while it resolves. */
  policy: TriggerPolicy | undefined
  unreadCount: number
}

export type TriageConversationState =
  | { status: "idle" }
  | { status: "loading" }
  /** No session with that id, or one with no platform binding. */
  | { status: "missing" }
  | { status: "ready"; conversation: TriageConversation }

export function useTriageConversation(
  sessionId: string | null | undefined
): TriageConversationState {
  const session = useLiveQuery<ChatSession | null>(async () => {
    if (typeof window === "undefined" || !sessionId) return null
    return (await getDb().sessions.get(sessionId)) ?? null
  }, [sessionId])
  const unreadCount = useLiveQuery<number>(async () => {
    if (typeof window === "undefined" || !sessionId) return 0
    return Math.max(0, (await getDb().sessionState.get(sessionId))?.unreadCount ?? 0)
  }, [sessionId])

  const binding = session?.platformBinding
  const conversationKey = binding?.conversationKey
  const adapterId = binding?.adapterId
  const override = useConversationOverride(conversationKey)
  const adapter = useAdapterInstance(adapterId)
  const resolved = useResolvedBinding(
    binding ? { adapterId: binding.adapterId, conversationKey: binding.conversationKey } : null
  )

  if (!sessionId) return { status: "idle" }
  if (session === undefined) return { status: "loading" }
  if (session === null || !binding) return { status: "missing" }
  return {
    status: "ready",
    conversation: {
      session,
      conversationKey: binding.conversationKey,
      adapterId: binding.adapterId,
      platform: binding.platform,
      override,
      adapter,
      policy: resolved?.trigger,
      unreadCount: unreadCount ?? 0,
    },
  }
}

"use client"

/**
 * The repository paths a conversation changed (`lib/git/conversation-scope`),
 * kept current: the tool calls re-derive from the live transcript, and the
 * code-adoption turns re-read each time the conversation settles, which is
 * when the host records a turn.
 */

import { useEffect, useMemo, useState } from "react"
import type { UIMessage } from "ai"
import { listCodeAdoptionTurnsBySession } from "@/lib/code-adoption/persist"
import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import { conversationRepoPaths, editedPathsFromMessages } from "@/lib/git/conversation-scope"
import { useChatStore } from "@/stores/chat/chat-store"

const NO_MESSAGES: UIMessage[] = []
const NO_TURNS: CodeAdoptionTurnRow[] = []

export interface ConversationChangedPaths {
  /** Repository-relative paths the conversation touched. */
  paths: ReadonlySet<string>
  /** False until the recorded turns have been read once. */
  ready: boolean
}

export function useConversationChangedPaths(
  sessionId: string | null | undefined,
  rootPath: string
): ConversationChangedPaths {
  // The focused session's transcript lives on the store's top level; its
  // slice may not exist yet.
  const messages = useChatStore((s) =>
    !sessionId
      ? NO_MESSAGES
      : s.activeSessionId === sessionId
        ? s.messages
        : (s.sessions[sessionId]?.messages ?? NO_MESSAGES)
  )
  const status = useChatStore((s) =>
    !sessionId
      ? "idle"
      : s.activeSessionId === sessionId
        ? s.status
        : (s.sessions[sessionId]?.status ?? "idle")
  )
  const settled = status === "idle" || status === "error"

  const [read, setRead] = useState<{ sessionId: string; turns: CodeAdoptionTurnRow[] } | null>(null)
  useEffect(() => {
    if (!sessionId || !settled) return
    let cancelled = false
    void listCodeAdoptionTurnsBySession(sessionId)
      .then((turns) => {
        if (!cancelled) setRead({ sessionId, turns })
      })
      .catch(() => {
        // Attribution is best-effort; the tool calls still narrow the list.
        if (!cancelled) setRead({ sessionId, turns: NO_TURNS })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, settled])

  const turns = read && read.sessionId === sessionId ? read.turns : NO_TURNS
  const toolPaths = useMemo(() => editedPathsFromMessages(messages), [messages])
  const paths = useMemo(
    () => conversationRepoPaths({ rootPath, toolPaths, turns }),
    [rootPath, toolPaths, turns]
  )
  return { paths, ready: !sessionId || (read !== null && read.sessionId === sessionId) }
}

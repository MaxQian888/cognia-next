"use client"

/**
 * Everything a session is waiting on the user for, as one list.
 *
 * Three stores hold the three kinds: tool approvals on the chat session,
 * external-agent elicitations, and the `ask_user` tool's prompt queue. The
 * overview's status rail only needed a yes/no, so it used to collapse them on
 * the spot; the summary card lists them, so the collapse now lives here and
 * the yes/no is derived from the list.
 */

import { useMemo } from "react"

import { useAskUserStore } from "@/stores/agent/ask-user-store"
import { useExternalElicitationStore } from "@/stores/agent/external-elicitation-store"
import { useSessionMessages, useSessionPendingApprovals } from "@/stores/chat"

export type NeedsYouKind = "approval" | "question" | "elicitation"

export interface NeedsYouItem {
  kind: NeedsYouKind
  id: string
  /** What to show: the tool's display name, the question, or the agent's message. */
  label: string
}

export interface SessionNeedsYou {
  items: NeedsYouItem[]
  /**
   * Where the dialogs for these items sit in the transcript. Approvals carry
   * no message id, so this is the latest assistant message — the turn that is
   * waiting. Null for a session with no assistant message yet.
   */
  jumpMessageId: string | null
}

const NO_ELICITATIONS: never[] = []

export function useSessionNeedsYou(sessionId: string): SessionNeedsYou {
  const approvals = useSessionPendingApprovals(sessionId)
  const elicitations = useExternalElicitationStore(
    (state) => state.bySession[sessionId] ?? NO_ELICITATIONS
  )
  const activeAsk = useAskUserStore((state) => state.active)
  const queuedAsks = useAskUserStore((state) => state.queue)
  const messages = useSessionMessages(sessionId)

  const items = useMemo<NeedsYouItem[]>(() => {
    const list: NeedsYouItem[] = []
    for (const approval of approvals) {
      // An interrupted approval was already denied; its dialog only explains why.
      if (approval.status === "interrupted") continue
      list.push({
        kind: "approval",
        id: approval.requestId,
        label: approval.title ?? approval.displayName ?? approval.toolName,
      })
    }
    for (const ask of [activeAsk, ...queuedAsks]) {
      if (!ask || ask.sessionId !== sessionId) continue
      list.push({ kind: "question", id: ask.id, label: ask.request.question })
    }
    for (const elicitation of elicitations) {
      list.push({
        kind: "elicitation",
        id: elicitation.request.id,
        label: elicitation.request.message,
      })
    }
    return list
  }, [approvals, activeAsk, queuedAsks, elicitations, sessionId])

  const jumpMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") return messages[index].id
    }
    return null
  }, [messages])

  return { items, jumpMessageId }
}

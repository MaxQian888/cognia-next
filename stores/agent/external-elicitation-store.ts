"use client"

/**
 * Questions an external agent is blocking on, per chat session.
 *
 * The sibling of the chat store's `pendingApprovals`, kept separate for one
 * reason: an approval is a `PendingApproval` — a tool name and an input object
 * — while an elicitation carries a JSON schema the chat store has no shape for.
 * Widening `SessionChatSlice` would mean touching its type, its initial state,
 * its mirror key list, its projection and its reducers, five call sites deep in
 * a 1400-line store, to carry something only one runtime produces.
 *
 * Keyed by CHAT session because the dialog renders inside a pane. The agent id
 * travels with the entry because `respondToElicitation` routes by agent alone —
 * the adapter correlates the answer by `requestId`, so the agent's own session
 * id is not part of the address.
 *
 * One question is shown at a time per session; the rest queue behind it, the
 * same discipline `ask-user-store` uses. An agent that asks twice before the
 * first answer would otherwise stack two dialogs and the user would answer the
 * top one, which is not the one they read.
 */

import { create } from "zustand"

import type { AcpElicitationRequest } from "@/types/agent/external-agent"

export interface PendingExternalElicitation {
  /** The chat session whose pane shows the dialog. */
  chatSessionId: string
  /** Manager agent id — `respondToElicitation`'s only routing argument. */
  agentId: string
  request: AcpElicitationRequest
  /**
   * Set when the agent runs on a paired host: the answer travels as an RPC
   * rather than to a local adapter. The dialog does not care — it renders the
   * same request either way — so only the responder branches on this.
   */
  remoteDecisionId?: string
}

interface ExternalElicitationState {
  /** Per chat session, oldest first. Index 0 is the one on screen. */
  bySession: Record<string, PendingExternalElicitation[]>
  push: (entry: PendingExternalElicitation) => void
  /** Drop one answered/withdrawn question. */
  remove: (chatSessionId: string, requestId: string) => void
  /** Drop every question for a session; returns what was dropped. */
  clearSession: (chatSessionId: string) => PendingExternalElicitation[]
}

export const useExternalElicitationStore = create<ExternalElicitationState>((set, get) => ({
  bySession: {},
  push: (entry) =>
    set((s) => {
      const current = s.bySession[entry.chatSessionId] ?? []
      // A re-emitted question (adapter reconnect) must not stack a duplicate
      // dialog behind the one already on screen.
      if (current.some((e) => e.request.id === entry.request.id)) return s
      return { bySession: { ...s.bySession, [entry.chatSessionId]: [...current, entry] } }
    }),
  remove: (chatSessionId, requestId) =>
    set((s) => {
      const current = s.bySession[chatSessionId]
      if (!current) return s
      // Matched against BOTH ids on purpose. The dialog answers by
      // `request.id` (the local correlation id), but an agent that withdraws a
      // question emits `elicitation_complete` carrying `elicitationId`, which
      // is a different field. Matching only one of them leaves a withdrawn
      // question on screen with no agent behind it.
      const next = current.filter(
        (e) => e.request.id !== requestId && e.request.elicitationId !== requestId
      )
      if (next.length === current.length) return s
      const bySession = { ...s.bySession }
      if (next.length === 0) delete bySession[chatSessionId]
      else bySession[chatSessionId] = next
      return { bySession }
    }),
  clearSession: (chatSessionId) => {
    const dropped = get().bySession[chatSessionId] ?? []
    if (dropped.length === 0) return []
    set((s) => {
      const bySession = { ...s.bySession }
      delete bySession[chatSessionId]
      return { bySession }
    })
    return dropped
  },
}))

const EMPTY: PendingExternalElicitation[] = []

/** The question this session is currently blocked on, if any. */
export function useSessionPendingElicitation(
  sessionId: string | null
): PendingExternalElicitation | null {
  return useExternalElicitationStore((s) =>
    sessionId ? ((s.bySession[sessionId] ?? EMPTY)[0] ?? null) : null
  )
}

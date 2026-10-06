"use client"

import { create } from "zustand"
import { mergeComposerIntentPrompt } from "@/lib/chat/merge-composer-intent"

export interface PendingComposerIntent {
  candidateId: string
  /** `null` means focus the Composer without inserting a stock instruction. */
  prompt: string | null
  mode?: "append" | "replace"
  images?: Array<{ data: string; mimeType: string }>
  /** Reject a delayed runtime edit if the conversation now points elsewhere. */
  externalSession?: { agentId: string; sessionId: string }
  /**
   * Send the staged text immediately instead of leaving it for the user to
   * edit. Used by the tray quick panel's "delegate" action — the whole point
   * of that surface is to hand off work without opening the app first.
   *
   * The selection toolbar never sets it: its prompts are starting points the
   * user is expected to adjust before sending.
   */
  autoSend?: boolean
}

interface ComposerIntentState {
  pendingBySession: Record<string, PendingComposerIntent>
  claimedEffects: Record<string, string[]>
  claimEffect: (scope: string, id: string) => boolean
  stage: (sessionId: string, intent: PendingComposerIntent) => void
  consume: (sessionId: string, candidateId: string) => PendingComposerIntent | null
}

export const useComposerIntentStore = create<ComposerIntentState>((set, get) => ({
  pendingBySession: {},
  claimedEffects: {},
  claimEffect: (scope, id) => {
    if (get().claimedEffects[scope]?.includes(id)) return false
    set((state) => ({
      claimedEffects: {
        ...state.claimedEffects,
        [scope]: [...(state.claimedEffects[scope] ?? []).slice(-63), id],
      },
    }))
    return true
  },
  stage: (sessionId, intent) =>
    set((state) => {
      const pending = state.pendingBySession[sessionId]
      const sameRuntime =
        pending?.externalSession &&
        intent.externalSession &&
        pending.externalSession.agentId === intent.externalSession.agentId &&
        pending.externalSession.sessionId === intent.externalSession.sessionId
      // A cancelled queue belongs to the human. Preserve its append when an
      // extension also replaces the editor before the composer can consume it.
      const combined =
        sameRuntime && (pending.mode === "append" || intent.mode === "append")
          ? {
              ...intent,
              mode:
                pending.mode === "replace" || intent.mode === "replace"
                  ? ("replace" as const)
                  : ("append" as const),
              prompt:
                intent.mode === "replace"
                  ? mergeComposerIntentPrompt(intent.prompt ?? "", pending.prompt ?? "")
                  : mergeComposerIntentPrompt(pending.prompt ?? "", intent.prompt ?? ""),
              images: [...(pending.images ?? []), ...(intent.images ?? [])],
            }
          : intent
      return { pendingBySession: { ...state.pendingBySession, [sessionId]: combined } }
    }),
  consume: (sessionId, candidateId) => {
    const intent = get().pendingBySession[sessionId]
    if (!intent || intent.candidateId !== candidateId) return null
    set((state) => {
      const pendingBySession = { ...state.pendingBySession }
      delete pendingBySession[sessionId]
      return { pendingBySession }
    })
    return intent
  },
}))

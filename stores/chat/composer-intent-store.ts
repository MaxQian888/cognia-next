"use client"

import { create } from "zustand"

export interface PendingComposerIntent {
  candidateId: string
  /** `null` means focus the Composer without inserting a stock instruction. */
  prompt: string | null
}

interface ComposerIntentState {
  pendingBySession: Record<string, PendingComposerIntent>
  stage: (sessionId: string, intent: PendingComposerIntent) => void
  consume: (sessionId: string, candidateId: string) => PendingComposerIntent | null
}

export const useComposerIntentStore = create<ComposerIntentState>((set, get) => ({
  pendingBySession: {},
  stage: (sessionId, intent) =>
    set((state) => ({
      pendingBySession: { ...state.pendingBySession, [sessionId]: intent },
    })),
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

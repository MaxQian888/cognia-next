"use client"

import { create } from "zustand"

export interface SideChatRequest {
  id: string
  question: string
}

interface SideChatRequestState {
  pending: Record<string, SideChatRequest[]>
  enqueue: (sessionId: string, question: string) => void
  claim: (sessionId: string, id: string) => SideChatRequest | null
}

/** Requests survive a closed dock; claiming before dispatch also protects Strict Mode. */
export const useSideChatRequestStore = create<SideChatRequestState>((set, get) => ({
  pending: {},
  enqueue: (sessionId, question) =>
    set((state) => ({
      pending: {
        ...state.pending,
        [sessionId]: [...(state.pending[sessionId] ?? []), { id: crypto.randomUUID(), question }],
      },
    })),
  claim: (sessionId, id) => {
    const request = get().pending[sessionId]?.find((item) => item.id === id)
    if (!request) return null
    set((state) => ({
      pending: {
        ...state.pending,
        [sessionId]: state.pending[sessionId].filter((item) => item.id !== id),
      },
    }))
    return request
  },
}))

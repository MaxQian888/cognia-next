/**
 * Where "new messages" starts in each open conversation (ADR-0177, batch 2).
 *
 * `sessionState.lastReadAt` moves to now the moment a session opens, which
 * is right for the badge and wrong for the reader: by the time the list
 * renders, the pointer that said where they stopped reading is gone. This
 * store keeps that pointer for the length of one visit. The shell captures
 * it before it marks the session read, the list draws the divider above the
 * first message newer than it, and a send or a switch away drops it.
 *
 * Transient by design: it is a property of this visit, not of the session.
 */

import { create } from "zustand"

export interface UnreadMarkerState {
  /** Per session, the `lastReadAt` captured when this visit opened it. */
  markers: Record<string, number>
  /** Record the pointer for a session, or drop it with `null`. */
  setMarker: (sessionId: string, lastReadAt: number | null) => void
}

export const useUnreadMarkerStore = create<UnreadMarkerState>()((set) => ({
  markers: {},
  setMarker: (sessionId, lastReadAt) =>
    set((state) => {
      const current = state.markers[sessionId]
      if ((current ?? null) === lastReadAt) return state
      const markers = { ...state.markers }
      if (lastReadAt === null) delete markers[sessionId]
      else markers[sessionId] = lastReadAt
      return { markers }
    }),
}))

/** The captured pointer for `sessionId`, or `null`. */
export function useUnreadMarker(sessionId: string | null | undefined): number | null {
  return useUnreadMarkerStore((state) => (sessionId ? (state.markers[sessionId] ?? null) : null))
}

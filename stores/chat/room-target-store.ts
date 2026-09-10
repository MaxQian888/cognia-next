/**
 * Which room members the composer's next send is aimed at (ADR-0177,
 * batch 3): the manual member picker's state.
 *
 * Per session, in pick order, kept until the user changes it. It is not
 * cleared on send on purpose: a `manual` team's user picks who answers and
 * expects the pick to hold for the follow-ups, the way an addressed DM stays
 * addressed. The chip in the composer's context row is what makes a standing
 * pick visible, and its clear button is what ends it.
 *
 * Transient: a property of this visit, like the reply target and the typing
 * signal, not of the session row.
 */

import { create } from "zustand"

export interface RoomTargetState {
  /** Per session, the picked member ids in pick order. */
  targets: Record<string, readonly string[]>
  /** Replace the session's pick. An empty list drops it. */
  setTargets: (sessionId: string, memberIds: readonly string[]) => void
  toggleTarget: (sessionId: string, memberId: string) => void
}

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a) return b.length === 0
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export const useRoomTargetStore = create<RoomTargetState>()((set, get) => ({
  targets: {},
  setTargets: (sessionId, memberIds) =>
    set((state) => {
      const next = Array.from(new Set(memberIds.filter(Boolean)))
      if (sameList(state.targets[sessionId], next)) return state
      const targets = { ...state.targets }
      if (next.length === 0) delete targets[sessionId]
      else targets[sessionId] = next
      return { targets }
    }),
  toggleTarget: (sessionId, memberId) => {
    const current = get().targets[sessionId] ?? []
    get().setTargets(
      sessionId,
      current.includes(memberId) ? current.filter((id) => id !== memberId) : [...current, memberId]
    )
  },
}))

const NONE: readonly string[] = []

/** The picked members for `sessionId`, an empty list when none. */
export function roomTargetsOf(sessionId: string | null | undefined): readonly string[] {
  return sessionId ? (useRoomTargetStore.getState().targets[sessionId] ?? NONE) : NONE
}

export function useRoomTargets(sessionId: string | null | undefined): readonly string[] {
  return useRoomTargetStore((state) => (sessionId ? (state.targets[sessionId] ?? NONE) : NONE))
}

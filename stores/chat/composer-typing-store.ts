/**
 * When the human last typed into each room's composer (ADR-0177, batch 3).
 *
 * The room runner reads this before every auto round: a keystroke within
 * `TYPING_WINDOW_MS` means the person is mid-sentence, and the members wait
 * rather than talk over them. A plain zustand module, so the runner reads it
 * in Node the same way the composer writes it in React. Nothing subscribes:
 * the value is polled at round boundaries, never rendered.
 *
 * Transient by design. It says nothing about the session, only about the
 * last few seconds of this visit.
 */

import { create } from "zustand"

export interface ComposerTypingState {
  /** Per session, the time of the last keystroke. */
  typedAt: Record<string, number>
  /** Record a keystroke, or clear the session's entry with `null`. */
  noteTyping: (sessionId: string, at: number | null) => void
}

export const useComposerTypingStore = create<ComposerTypingState>()((set) => ({
  typedAt: {},
  noteTyping: (sessionId, at) =>
    set((state) => {
      if ((state.typedAt[sessionId] ?? null) === at) return state
      const typedAt = { ...state.typedAt }
      if (at === null) delete typedAt[sessionId]
      else typedAt[sessionId] = at
      return { typedAt }
    }),
}))

/** The last keystroke in `sessionId`'s composer, or `null`. */
export function lastTypedAt(sessionId: string): number | null {
  return useComposerTypingStore.getState().typedAt[sessionId] ?? null
}

/** The composer's write. `at` defaults to now. */
export function noteComposerTyping(sessionId: string, at: number = Date.now()): void {
  useComposerTypingStore.getState().noteTyping(sessionId, at)
}

/** The composer sent, so the draft that was being typed is gone. */
export function clearComposerTyping(sessionId: string): void {
  useComposerTypingStore.getState().noteTyping(sessionId, null)
}

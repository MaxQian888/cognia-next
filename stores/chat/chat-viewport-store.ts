"use client"

/**
 * Chat Viewport Store — the seam between the message list and the surfaces
 * that sit outside it (today: the artifact dock).
 *
 * Two things cross that boundary, and both used to be locked inside
 * `MessageList`:
 *
 * - **Which turn is on screen.** The dock highlights the artifact tab produced
 *   by the message you are looking at. This is deliberately a store and not a
 *   prop: `useTimelineScrollSync` recomputes on every scroll frame, and the
 *   message list must not re-render with it (that hook is explicitly built to
 *   avoid exactly that). The publisher is a leaf that renders nothing, and it
 *   only writes here when the turn actually changes — so the dock re-renders
 *   per *message*, not per frame.
 *
 * - **How to jump to a message.** Scrolling to a message needs the scroll
 *   container and the virtualizer, so only the list can do it. It had been
 *   written twice (the find bar and the timeline minimap each had their own
 *   copy) and exposed nowhere, which is why "go to the message that produced
 *   this artifact" had no seam to call.
 *
 * Only the primary message list registers here. Secondary lists — the dock's
 * own per-resource chat panel is one — would otherwise clobber the main
 * conversation's jump target with their own.
 */

import { create } from "zustand"

import type { JumpAlign } from "@/lib/chat/message-anchor"

const EMPTY_IDS: readonly string[] = []

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export interface ChatViewportState {
  /**
   * Message ids of the turn currently at the top of the chat viewport. A turn,
   * not a message, because an artifact is produced by an assistant reply while
   * the timeline tracks user turns — matching against the whole turn is what
   * lines the two up.
   */
  activeTurnMessageIds: readonly string[]
  /** No-ops when the turn is unchanged, so per-frame writes cost nothing. */
  setActiveTurnMessageIds: (ids: readonly string[]) => void
  /**
   * Registered by the primary message list; null when none is mounted.
   *
   * `index` is an optional fast path for callers that already know the row
   * (the minimap and the find bar do); everything else looks it up by id.
   *
   * `align` is the caller's intent, not a style: a timeline anchor is the
   * user's own question and wants to rest at the TOP so the reply reads
   * downwards from it, while a search hit or an artifact's source message is a
   * point of interest and wants to be centred. Defaults to `center`.
   *
   * Returns whether the jump resolved a row. A message can be absent — it was
   * compacted away, it belongs to another session, or the id is stale — and
   * that used to be a silent no-op, so callers could offer "go to source" on
   * something they could not reach. Callers must surface `false`.
   */
  jumpToMessage: JumpToMessage | null
  registerJumpToMessage: (jump: JumpToMessage | null) => void
}

export type JumpToMessage = (
  messageId: string,
  index?: number,
  opts?: { align?: JumpAlign }
) => boolean

export const useChatViewportStore = create<ChatViewportState>()((set, get) => ({
  activeTurnMessageIds: EMPTY_IDS,
  jumpToMessage: null,

  setActiveTurnMessageIds: (ids) => {
    if (sameIds(get().activeTurnMessageIds, ids)) return
    set({ activeTurnMessageIds: ids.length === 0 ? EMPTY_IDS : [...ids] })
  },

  registerJumpToMessage: (jumpToMessage) =>
    set((state) =>
      // Unregistering is scoped to whoever is currently registered: a
      // secondary list unmounting must not tear out the primary list's jump.
      jumpToMessage === null && state.jumpToMessage === null ? state : { jumpToMessage }
    ),
}))

export default useChatViewportStore

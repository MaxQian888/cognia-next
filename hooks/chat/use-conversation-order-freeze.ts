"use client"

import { useMemo, useState } from "react"

import {
  freezeConversationLayout,
  projectFrozenSections,
  type FrozenConversationLayout,
} from "@/lib/chat/conversation-order-freeze"
import type { ConversationSection } from "@/lib/chat/conversation-list-model"

/**
 * Keep the conversation list still while the pointer is over it.
 *
 * The list is a live query ordered by last activity, so a background
 * conversation — an inbound IM message, an agent run finishing — re-sorts it
 * under the cursor. The model already guarantees a *total* order, so rows never
 * flicker between two arrangements; what it cannot do is know that a human is
 * mid-reach.
 *
 * Hover is the whole signal, and deliberately so. It marks the one moment a
 * moving row costs something — you are aiming at one — and it is
 * self-limiting: the hold lasts exactly as long as the pointer is there and
 * settles the instant it leaves. That is what lets this be invisible, with
 * nothing to announce and no way to get stuck inside it.
 *
 * An earlier version also froze on scroll position, and needed a "N updates"
 * pill to escape a hold that could outlive its reason (scroll down, walk away).
 * The pill was the tell: a mechanism that needs an exit is holding on too long.
 * Worse, it fired for the conversation you were *typing into* — its own new
 * message re-sorts the list like any other. Scrolled-but-not-hovered means you
 * are reading, not aiming, and a row moving then is the list doing its job.
 *
 * Only order is held; see `lib/chat/conversation-order-freeze.ts` for why
 * additions and removals are not.
 */

export interface UseConversationOrderFreezeParams {
  /** The model's live sections. */
  sections: readonly ConversationSection[]
  /** True while the pointer is inside the list. Always false on touch. */
  hovering: boolean
  /**
   * Turn the mechanism off. Search results and a drag in progress have their
   * own ordering stories, and a freeze on top of either would be a third.
   */
  disabled?: boolean
}

/** Sections to render: the held order while hovering, the live ones otherwise. */
export function useConversationOrderFreeze({
  sections,
  hovering,
  disabled = false,
}: UseConversationOrderFreezeParams): readonly ConversationSection[] {
  const shouldFreeze = !disabled && hovering
  const [held, setHeld] = useState<FrozenConversationLayout | null>(null)

  // Adjust state from props during render (React's documented pattern, the same
  // one the drag projection below the list uses). An effect would capture one
  // frame late — the frame that already showed the reader a re-sorted list,
  // which is the frame this exists to prevent.
  let layout: FrozenConversationLayout | null = null
  if (shouldFreeze) {
    if (held) {
      layout = held
    } else {
      // Capturing re-renders immediately; this pass renders the live order,
      // which is what the capture is *of*, so nothing moves in between.
      setHeld(freezeConversationLayout(sections))
    }
  } else if (held !== null) {
    setHeld(null)
  }

  return useMemo(
    () => (layout ? projectFrozenSections(layout, sections) : sections),
    [layout, sections]
  )
}

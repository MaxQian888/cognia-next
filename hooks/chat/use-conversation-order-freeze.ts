"use client"

import { useCallback, useMemo, useState } from "react"

import {
  freezeConversationLayout,
  frozenLayoutPending,
  projectFrozenSections,
  type FrozenConversationLayout,
} from "@/lib/chat/conversation-order-freeze"
import type { ConversationSection } from "@/lib/chat/conversation-list-model"

/**
 * Keep the conversation list still while someone is reading it.
 *
 * The list is a live query ordered by last activity, so a background
 * conversation — an inbound IM message, an agent run finishing — re-sorts it
 * under the cursor. The model already guarantees a *total* order, so rows never
 * flicker between two arrangements; what it cannot do is know that a human is
 * mid-reach.
 *
 * Freezing is driven by two signals the surface supplies, OR-ed:
 *
 * - **the pointer is over the list** — you are about to click something;
 * - **the list is scrolled** — you have gone looking, and the top is no longer
 *   where you are.
 *
 * Release is the conjunction: pointer gone *and* back at the top. Requiring
 * both is what keeps a freeze from outliving its reason — and from persisting
 * on a scrolled-away list nobody is looking at, the pill offers an immediate
 * way out.
 *
 * Only order is held; see `lib/chat/conversation-order-freeze.ts` for why
 * additions and removals are not.
 */

export interface UseConversationOrderFreezeParams {
  /** The model's live sections. */
  sections: readonly ConversationSection[]
  /** True while the pointer is inside the list. Always false on touch. */
  hovering: boolean
  /** True while the list is scrolled away from the top. */
  scrolled: boolean
  /**
   * Turn the whole mechanism off. Search results and a drag in progress have
   * their own ordering stories, and a freeze on top of either would be a third.
   */
  disabled?: boolean
}

export interface ConversationOrderFreeze {
  /** Sections to render — frozen while held, the live ones otherwise. */
  sections: readonly ConversationSection[]
  /** Rows the freeze is holding back; `0` while nothing is waiting. */
  pending: number
  /** True while an order is being held (whether or not anything is pending). */
  frozen: boolean
  /** Apply everything now and start over from the live order. */
  release: () => void
}

export function useConversationOrderFreeze({
  sections,
  hovering,
  scrolled,
  disabled = false,
}: UseConversationOrderFreezeParams): ConversationOrderFreeze {
  const shouldFreeze = !disabled && (hovering || scrolled)
  // The capture is tagged with the epoch it was taken in, so `release()` can
  // force a fresh one without the pointer having to leave and come back.
  const [held, setHeld] = useState<{ layout: FrozenConversationLayout; epoch: number } | null>(null)
  const [epoch, setEpoch] = useState(0)

  // Adjust state from props during render (React's documented pattern, the same
  // one the drag projection below the list uses). An effect would capture one
  // frame late — the frame that already showed the reader a re-sorted list,
  // which is the frame this exists to prevent.
  let layout: FrozenConversationLayout | null = null
  if (shouldFreeze) {
    if (held?.epoch === epoch) {
      layout = held.layout
    } else {
      // Capturing re-renders immediately; this pass renders the live order,
      // which is what the capture is *of*, so nothing moves in between.
      setHeld({ layout: freezeConversationLayout(sections), epoch })
    }
  } else if (held !== null) {
    setHeld(null)
  }

  const projected = useMemo(
    () => (layout ? projectFrozenSections(layout, sections) : sections),
    [layout, sections]
  )
  const pending = useMemo(
    () => (layout ? frozenLayoutPending(layout, sections) : 0),
    [layout, sections]
  )

  const release = useCallback(() => setEpoch((value) => value + 1), [])

  return { sections: projected, pending, frozen: layout !== null, release }
}

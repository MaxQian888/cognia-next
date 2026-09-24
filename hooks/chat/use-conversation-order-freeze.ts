"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  freezeConversationLayout,
  projectFrozenSections,
  type FrozenConversationLayout,
} from "@/lib/chat/conversation-order-freeze"
import {
  conversationSectionKey,
  type ConversationSection,
} from "@/lib/chat/conversation-list-model"

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
  /**
   * Turn the mechanism off. Search results and a drag in progress have their
   * own ordering stories, and a freeze on top of either would be a third.
   */
  disabled?: boolean
  /**
   * Keep group headers whose rows all left — the scope tree's squad groups
   * are navigation entities, not just buckets, so an empty one must not
   * flicker out while the pointer is still over the list.
   */
  preserveEmptyGroups?: boolean
  /**
   * Identity of the arrangement the reader chose — grouping and sort. The hold
   * exists for moves the reader did not make; a new sort is one they did, and
   * its control (the rail's "Filter and sort" menu) sits inside the hovered
   * list. When this changes while the pointer is inside, the hold re-captures
   * from the new live order instead of pinning the one the reader just left.
   */
  orderKey?: string
}

export interface ConversationOrderFreeze {
  /** Sections to render: the held order while hovering, the live ones otherwise. */
  sections: readonly ConversationSection[]
  /** Wire to the list's `onMouseEnter` — captures the order on screen. */
  onPointerEnter: () => void
  /** Wire to the list's `onMouseLeave` — lets the live order through again. */
  onPointerLeave: () => void
}

/**
 * Hold the list's order while the pointer is inside it.
 *
 * The hover signal arrives through the returned handlers rather than as a
 * prop, so the capture happens in the event — batched with the hover flag into
 * one render. Fed as a prop, every enter and leave cost the whole sidebar two
 * renders: one for the flag, and a second for the capture that had to be set
 * from inside that render.
 */
export function useConversationOrderFreeze({
  sections,
  disabled = false,
  preserveEmptyGroups = false,
  orderKey = "",
}: UseConversationOrderFreezeParams): ConversationOrderFreeze {
  const [hovering, setHovering] = useState(false)
  const [held, setHeld] = useState<FrozenConversationLayout | null>(null)
  // The arrangement `held` was captured under; see `orderKey`.
  const [heldKey, setHeldKey] = useState(orderKey)

  // What the reader is looking at when the pointer arrives: the sections of the
  // last commit. Written in an effect; React flushes passive effects before it
  // dispatches the next discrete event, so the handler always sees the paint.
  const shownRef = useRef(sections)
  const shownKeyRef = useRef(orderKey)
  const disabledRef = useRef(disabled)
  useEffect(() => {
    shownRef.current = sections
    shownKeyRef.current = orderKey
    disabledRef.current = disabled
  }, [sections, orderKey, disabled])

  const onPointerEnter = useCallback(() => {
    setHovering(true)
    if (!disabledRef.current) {
      setHeld(freezeConversationLayout(shownRef.current))
      setHeldKey(shownKeyRef.current)
    }
  }, [])
  const onPointerLeave = useCallback(() => {
    setHovering(false)
    setHeld(null)
  }, [])

  // The rare transitions still adjust during render (React's documented
  // "adjust state from props" pattern): a search or a drag starting under the
  // pointer drops the hold — they own the order now — and one ending while the
  // pointer is still inside captures afresh, as does a new grouping or sort
  // (`orderKey`). An effect would do any of these one frame late, and that
  // frame is the one showing the reader the wrong list.
  const shouldFreeze = hovering && !disabled
  if (!shouldFreeze && held !== null) {
    setHeld(null)
  } else if (shouldFreeze && (held === null || heldKey !== orderKey)) {
    setHeld(freezeConversationLayout(sections))
    setHeldKey(orderKey)
  }
  const layout = shouldFreeze && heldKey === orderKey ? held : null

  const displayed = useMemo(() => {
    if (!layout) return sections
    const projected = projectFrozenSections(layout, sections, { preserveEmptyGroups })
    // Nothing moved since the capture — the usual case, and every hover
    // starts in it. Hand back the live array so the list below sees the same
    // identity and skips its render entirely.
    return sameLayout(projected, sections) ? sections : projected
  }, [layout, sections, preserveEmptyGroups])
  return useMemo(
    () => ({ sections: displayed, onPointerEnter, onPointerLeave }),
    [displayed, onPointerEnter, onPointerLeave]
  )
}

/** Same sections, same rows (by identity), same order, same fold state. */
function sameLayout(a: readonly ConversationSection[], b: readonly ConversationSection[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!
    const right = b[i]!
    if (left === right) continue
    if (conversationSectionKey(left) !== conversationSectionKey(right)) return false
    if ("collapsed" in left && "collapsed" in right && left.collapsed !== right.collapsed) {
      return false
    }
    if (left.kind === "group" && right.kind === "group") {
      if ((left.previewHidden ?? 0) !== (right.previewHidden ?? 0)) return false
    }
    if (left.sessions.length !== right.sessions.length) return false
    for (let j = 0; j < left.sessions.length; j++) {
      if (left.sessions[j] !== right.sessions[j]) return false
    }
  }
  return true
}

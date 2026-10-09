"use client"

// Keep a view's React state alive while the place that shows it comes and
// goes. The project editor's explorer and search live as panels of the file
// context workbench, whose body unmounts whenever the sidebar folds — a plain
// panel renderer would lose the tree's expanded folders and the search query on
// every fold. Instead the editor renders each view once, through a portal, into
// a detached element it owns ("parked"), and the panel only *adopts* that
// element into its own box while it is on screen. React never unmounts the
// view; only its DOM node moves.

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ReactNode } from "react"

/** A detached element to portal a view into; null during SSR. */
export function useParkedViewTarget(): HTMLElement | null {
  const [target] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null
    const element = document.createElement("div")
    element.className = "h-full min-h-0"
    return element
  })
  return target
}

/** Render `children` into the parked `target`, wherever it currently lives. */
export function ParkedView({
  target,
  children,
}: {
  target: HTMLElement | null
  children: ReactNode
}) {
  return target ? createPortal(children, target) : null
}

/** Show the parked view here: adopts `target` into this box while mounted. */
export function ParkedViewSlot({
  target,
  className = "h-full min-h-0",
  testId,
}: {
  target: HTMLElement | null
  className?: string
  testId?: string
}) {
  const slotRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const slot = slotRef.current
    if (!slot || !target) return
    slot.appendChild(target)
    return () => {
      // Only detach if no other slot adopted it in the meantime.
      if (target.parentElement === slot) slot.removeChild(target)
    }
  }, [target])
  return <div ref={slotRef} className={className} data-testid={testId} />
}

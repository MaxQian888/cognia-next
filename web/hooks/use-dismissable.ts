"use client"

import { type RefObject, useCallback, useEffect, useRef, useState } from "react"

/**
 * Open/close state for the two overlays the site has — the Product dropdown and
 * the mobile navigation sheet — with the dismissal behaviour a keyboard user
 * expects: Escape closes, a pointer press outside closes, and focus returns to
 * the control that opened it.
 *
 * Both overlays need exactly this, and getting focus return wrong is the kind
 * of defect that only shows up for the people who most depend on it, so it
 * lives in one tested place rather than twice inline.
 */
export interface Dismissable<T extends HTMLElement> {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
  close: () => void
  /** Attach to the overlay's container so outside presses can be detected. */
  containerRef: RefObject<T | null>
  /** Attach to the control that opens it so focus can be returned. */
  triggerRef: RefObject<HTMLButtonElement | null>
}

export function useDismissable<T extends HTMLElement = HTMLDivElement>(): Dismissable<T> {
  const [open, setOpenState] = useState(false)
  const containerRef = useRef<T | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  // Only return focus for a dismissal, never for the initial render, or the
  // page would steal focus on mount.
  const wasOpen = useRef(false)

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
  }, [])

  const close = useCallback(() => setOpenState(false), [])
  const toggle = useCallback(() => setOpenState((value) => !value), [])

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) triggerRef.current?.focus()
      wasOpen.current = false
      return
    }
    wasOpen.current = true

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation()
        setOpenState(false)
      }
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null
      if (!target) return
      if (containerRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpenState(false)
    }

    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("pointerdown", onPointerDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("pointerdown", onPointerDown)
    }
  }, [open])

  return { open, setOpen, toggle, close, containerRef, triggerRef }
}

"use client"

/**
 * Global keyboard shortcuts for the observability dashboard. Attaches a single
 * window `keydown` listener and dispatches unmodified single-key presses:
 *
 *   e → toggle edit/lock layout    r → refresh now
 *   f → focus the filter bar       s → open settings
 *
 * Presses are ignored while the user is typing (input / textarea / select /
 * contenteditable) or holding a modifier, so they never fight normal editing.
 * Handlers are read through a ref so the listener is subscribed once and never
 * churns on re-render.
 */

import { useEffect, useRef } from "react"

export interface HotkeyHandlers {
  onToggleEdit?: () => void
  onRefresh?: () => void
  onFocusFilter?: () => void
  onOpenSettings?: () => void
}

/** True when the event originated from an editable control we must not hijack. */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true
}

export function useObservabilityHotkeys(handlers: HotkeyHandlers): void {
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditableTarget(e.target)) return
      const h = ref.current
      const run = (fn: (() => void) | undefined) => {
        if (!fn) return
        e.preventDefault()
        fn()
      }
      switch (e.key.toLowerCase()) {
        case "e":
          run(h.onToggleEdit)
          break
        case "r":
          run(h.onRefresh)
          break
        case "f":
          run(h.onFocusFilter)
          break
        case "s":
          run(h.onOpenSettings)
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}

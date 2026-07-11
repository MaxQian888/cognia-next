"use client"

import { useEffect, useRef } from "react"

/**
 * Close an overlay (Sheet / Drawer / dialog) on Android hardware back or
 * browser back instead of letting the navigation rip the route out from
 * under it.
 *
 * Pattern (extracted from `mobile-workflow-copilot-sheet.tsx`, previously the
 * only mobile surface that handled back correctly): push a marker history
 * entry when the overlay opens; a `popstate` while open means "back pressed"
 * → dismiss; closing by any other means pops the marker entry ourselves so
 * the history stack stays balanced.
 *
 * The dismiss callback is kept in a ref so callers can pass an inline
 * closure without re-arming the effect every render.
 */
export function useBackDismiss(open: boolean, onDismiss: () => void): void {
  const dismissRef = useRef(onDismiss)
  // Assigned in an effect (not during render) to satisfy react-hooks/refs;
  // popstate can only fire after the commit, so the ref is always current.
  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])
  const poppedRef = useRef(false)

  useEffect(() => {
    if (!open || typeof window === "undefined") return
    poppedRef.current = false
    const onPop = () => {
      poppedRef.current = true
      dismissRef.current()
    }
    window.history.pushState({ cogniaBackDismiss: true }, "")
    window.addEventListener("popstate", onPop)
    return () => {
      window.removeEventListener("popstate", onPop)
      // Unwinding for a reason OTHER than the user pressing back (tap on
      // scrim, explicit close button, unmount): drop the marker entry we
      // pushed so hardware back afterwards doesn't need a double press.
      if (
        !poppedRef.current &&
        (window.history.state as Record<string, unknown> | null)?.cogniaBackDismiss === true
      ) {
        window.history.back()
      }
    }
  }, [open])
}

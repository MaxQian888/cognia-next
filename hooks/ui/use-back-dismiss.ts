"use client"

import { useEffect, useRef } from "react"

/**
 * Marker entries whose overlays closed during the current commit and have not
 * yet been popped.
 *
 * `history.back()` is asynchronous. When one commit closes an overlay and opens
 * another — a sheet row that opens a second sheet, "Select" that turns on a mode
 * with its own back handling — the closing overlay's pop used to land after the
 * opening one had pushed its marker and started listening, took that new marker
 * off the stack, and was heard as the back button: the new overlay closed the
 * moment it opened. Verified in Chromium: a listener added after `back()`
 * receives its popstate.
 *
 * So the pop waits a microtask — past the rest of the commit — and an overlay
 * that opens in the meantime takes the entry over (`replaceState`) instead of
 * pushing its own. No traversal happens, so there is no popstate to mistake.
 */
const handoffs: { claimed: boolean }[] = []

function popOwnMarkerAfterCommit(): void {
  const handoff = { claimed: false }
  handoffs.push(handoff)
  queueMicrotask(() => {
    const index = handoffs.indexOf(handoff)
    if (index >= 0) handoffs.splice(index, 1)
    if (!handoff.claimed) window.history.back()
  })
}

function pushOrTakeOverMarker(): void {
  const marker = { cogniaBackDismiss: true }
  // Only a single closing overlay can be taken over: with two closing, the top
  // entry is the second one's, and the first one's pop would still remove it.
  if (handoffs.length === 1) {
    handoffs[0]!.claimed = true
    handoffs.length = 0
    window.history.replaceState(marker, "")
    return
  }
  window.history.pushState(marker, "")
}

/**
 * Close an overlay (Sheet / Drawer / dialog) on Android hardware back or
 * browser back instead of letting the navigation rip the route out from
 * under it.
 *
 * Pattern (extracted from `mobile-workflow-copilot-sheet.tsx`, previously the
 * only mobile surface that handled back correctly): push a marker history
 * entry when the overlay opens; a `popstate` while open means "back pressed"
 * → dismiss; closing by any other means pops the marker entry ourselves so
 * the history stack stays balanced. See {@link handoffs} for an overlay that
 * closes as another opens.
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
    pushOrTakeOverMarker()
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
        popOwnMarkerAfterCommit()
      }
    }
  }, [open])
}

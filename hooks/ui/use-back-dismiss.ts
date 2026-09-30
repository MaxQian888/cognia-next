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
 * Open Radix-family overlays that answer Escape: Dialog / Sheet / vaul Drawer /
 * Popover content (`role="dialog"`), AlertDialog, DropdownMenu / ContextMenu /
 * Menubar (`role="menu"`) and Select (`role="listbox"`). Radix stamps
 * `data-state="open"` on each while it is up and flips it to `closed` for the
 * exit animation, so a closing overlay does not count.
 */
const OPEN_OVERLAY_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
].join(",")

/**
 * A Radix tooltip is a dismissable layer too, and the one on top whenever it is
 * up. A dialog focuses its first control on open, and a control with a tooltip
 * opens that tooltip on focus (touch has no hover, so on a phone focus is the
 * only way one opens) — so the image viewer, for one, opens with its first
 * tool's tooltip showing, and an Escape there closes the tooltip, not the
 * viewer. Mounted until its exit animation ends.
 */
const TOOLTIP_SELECTOR = '[data-slot="tooltip-content"]'

/** How long to wait for a dismissed tooltip to unmount before giving up. */
const TOOLTIP_SETTLE_POLL_MS = 16
const TOOLTIP_SETTLE_MAX_POLLS = 40

function dispatchEscape(doc: Document): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    keyCode: 27,
    bubbles: true,
    cancelable: true,
  })
  doc.dispatchEvent(event)
  return event.defaultPrevented
}

/**
 * The press went to a tooltip sitting over `overlays`. Once the tooltip has
 * unmounted (and its layer left Radix's stack), give the overlay the Escape the
 * press was meant for — unless one of them already closed, in which case the
 * press did its job and a second Escape would close a layer too many.
 */
function redispatchAfterTooltip(doc: Document, overlays: Element[], polls = 0): void {
  setTimeout(() => {
    if (doc.querySelector(TOOLTIP_SELECTOR)) {
      if (polls < TOOLTIP_SETTLE_MAX_POLLS) redispatchAfterTooltip(doc, overlays, polls + 1)
      return
    }
    const stillOpen = overlays.every(
      (overlay) => overlay.isConnected && overlay.matches(OPEN_OVERLAY_SELECTOR)
    )
    if (stillOpen) dispatchEscape(doc)
  }, TOOLTIP_SETTLE_POLL_MS)
}

/**
 * Dismiss the topmost open overlay the way the Escape key would, for the
 * Android hardware back button. Returns `true` when an overlay took the press.
 *
 * Only overlays that opt into {@link useBackDismiss} push a history marker, so
 * before this every other sheet, dialog, drawer and menu let a back press fall
 * through to `history.back()` — or, with nothing behind it, `minimizeApp()`,
 * which backgrounded the app with the overlay still open. Every one of those
 * overlays already closes on Escape (Radix `DismissableLayer`, which only
 * listens on its highest layer and calls `preventDefault()` when it dismisses),
 * so one synthetic Escape covers all of them without each opting in, and an
 * overlay that refuses to close (its `onEscapeKeyDown` prevents default, e.g. a
 * discard confirmation) keeps the press too, as it would the key.
 *
 * The key is dispatched on the document, not the focused element: Radix listens
 * there in the capture phase, while element-level Escape handlers (the
 * composer's "Esc stops the run") are exactly what a back press must not reach.
 * With no open overlay nothing is dispatched at all. A tooltip over the overlay
 * takes the first Escape; see {@link redispatchAfterTooltip}.
 *
 * A `useBackDismiss` overlay that is not a Radix layer does not consume the key
 * and returns `false`, so the caller's `history.back()` still pops its marker.
 */
export function dismissTopmostOverlayOnBack(doc: Document = document): boolean {
  const overlays = Array.from(doc.querySelectorAll(OPEN_OVERLAY_SELECTOR))
  if (overlays.length === 0) return false
  const tooltipUp = doc.querySelector(TOOLTIP_SELECTOR) !== null
  const consumed = dispatchEscape(doc)
  if (consumed && tooltipUp) redispatchAfterTooltip(doc, overlays)
  return consumed
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

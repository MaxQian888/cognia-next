"use client"

import { useCallback, useSyncExternalStore } from "react"

import { getQuerySnapshot, subscribeToQuery } from "@/lib/platform/viewport-store"

/**
 * First-class input-capability hooks.
 *
 * These answer "can this device hover?" / "is the pointer coarse (finger)?"
 * in JS, for branches that CSS `[@media(hover:none)]` can't express (e.g.
 * choosing a Popover vs. a tap-to-open Sheet, or skipping hover-reveal logic).
 *
 * SSR default is desktop-like (`hasHover: true`, `coarsePointer: false`),
 * matching {@link detectInputCapabilities} so server and first client render
 * agree; `useSyncExternalStore` reconciles to the real value after hydration.
 */

const HOVER_QUERY = "(hover: hover)"
const COARSE_POINTER_QUERY = "(pointer: coarse)"

/** True when the primary pointer can hover (mouse/trackpad), not just tap. */
export function useHasHover(): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToQuery(HOVER_QUERY, onChange),
    []
  )
  // When `matchMedia` is unavailable (SSR / non-browser), default to the
  // desktop-like assumption (`true`) — matching `detectInputCapabilities` — so
  // the answer is consistent whether the snapshot is read on server or client.
  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true
    return getQuerySnapshot(HOVER_QUERY)
  }, [])
  return useSyncExternalStore(subscribe, getSnapshot, () => true)
}

/** True when the primary pointer is coarse (finger/stylus) rather than a fine mouse. */
export function useCoarsePointer(): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToQuery(COARSE_POINTER_QUERY, onChange),
    []
  )
  const getSnapshot = useCallback(() => getQuerySnapshot(COARSE_POINTER_QUERY), [])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/**
 * Whether keyboard-shortcut hints ("⌘/Ctrl+Enter", "Esc to interrupt",
 * "↑↓ navigate", "Shift+Tab") belong on screen.
 *
 * A phone has no Esc, no ⌘ and no arrow keys, so the hints are noise there at
 * best and instructions that cannot be followed at worst. The gate is the input
 * hardware rather than the runtime: a Capacitor shell, a phone browser and a
 * touch-only tablet all lack the keyboard, and a laptop browser has one. A
 * hover-capable, fine primary pointer is the signal a physical keyboard is
 * attached; either half missing hides the hints. SSR renders them (desktop
 * default, matching {@link useHasHover}).
 */
export function useShowKeyboardHints(): boolean {
  const hasHover = useHasHover()
  const coarsePointer = useCoarsePointer()
  return hasHover && !coarsePointer
}

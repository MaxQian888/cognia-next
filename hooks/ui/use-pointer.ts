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

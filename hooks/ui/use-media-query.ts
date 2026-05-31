"use client"

import { useCallback, useSyncExternalStore } from "react"

import { getQuerySnapshot, subscribeToQuery } from "@/lib/platform/viewport-store"

/**
 * Reactive media-query hook. Returns `false` on the server / when `matchMedia`
 * is unavailable so SSR / static export render the desktop-default layout, then
 * `useSyncExternalStore` reconciles to the real value on mount — without the
 * extra `false → real` effect render the old `useEffect`+`useState` version
 * produced. All call sites multiplex onto one `MediaQueryList` per query via
 * the shared viewport store.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToQuery(query, onChange),
    [query]
  )
  const getSnapshot = useCallback(() => getQuerySnapshot(query), [query])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** True when the viewport is below the Tailwind `md` breakpoint (768px). */
export function useIsNarrow(): boolean {
  return useMediaQuery("(max-width: 767.98px)")
}

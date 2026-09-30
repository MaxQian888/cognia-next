"use client"

import { useCallback, useSyncExternalStore } from "react"

import { getQuerySnapshot, subscribeToQuery } from "@/lib/platform/viewport-store"

const HOVER_NONE_QUERY = "(hover: none)"

/**
 * True only when the primary pointer positively reports that it CANNOT hover:
 * a phone, a touch-only tablet, the Capacitor WebView.
 *
 * Not the same as `!useHasHover()` (`./use-pointer`). That reads
 * "(hover: hover)" and answers false wherever the query is not understood or
 * not stubbed (an old WebView, a non-matching test double), which would treat
 * every such environment as touch. Hover-only affordances such as tooltips
 * should be withdrawn where the device says hover does not exist and left
 * alone everywhere else.
 *
 * Its own module rather than a sibling export of `use-pointer.ts`, because
 * `components/ui/tooltip.tsx` reads it and a great many suites replace
 * `use-pointer` wholesale with a factory that would not carry it.
 *
 * SSR answers false, the desktop default the other viewport hooks use.
 */
export function useCannotHover(): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToQuery(HOVER_NONE_QUERY, onChange),
    []
  )
  const getSnapshot = useCallback(() => getQuerySnapshot(HOVER_NONE_QUERY), [])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

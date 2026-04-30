"use client"

import { useEffect, useState } from "react"

/**
 * Reactive media-query hook. Returns `false` on the server so SSR / static
 * export render the desktop-default layout, then flips to the real value on
 * mount. That keeps hydration deterministic.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return

    const mq = window.matchMedia(query)
    const update = () => setMatches(mq.matches)
    update()

    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [query])

  return matches
}

/** True when the viewport is below the Tailwind `md` breakpoint (768px). */
export function useIsNarrow(): boolean {
  return useMediaQuery("(max-width: 767.98px)")
}

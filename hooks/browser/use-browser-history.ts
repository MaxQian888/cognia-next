import { useCallback, useState } from "react"

/** Cap on the in-memory recent-URL list surfaced by the address-bar menu. */
export const MAX_BROWSER_HISTORY = 25

export interface BrowserHistory {
  /** Visited URLs, most-recent-first. */
  recent: string[]
  /** Record a visit: moves an existing URL to the front, collapses consecutive dupes. */
  push: (url: string) => void
  /** Drop the whole list. */
  clear: () => void
}

/**
 * Most-recent-first list of visited URLs for the address-bar history menu.
 * In-memory per pane (no Dexie table) — the embedded preview only ever hosts a
 * handful of local dev URLs, so persistence isn't worth a schema bump.
 */
export function useBrowserHistory(): BrowserHistory {
  const [recent, setRecent] = useState<string[]>([])

  const push = useCallback((url: string) => {
    if (!url) return
    setRecent((prev) => {
      if (prev[0] === url) return prev
      const next = [url, ...prev.filter((entry) => entry !== url)]
      return next.length > MAX_BROWSER_HISTORY ? next.slice(0, MAX_BROWSER_HISTORY) : next
    })
  }, [])

  const clear = useCallback(() => setRecent([]), [])

  return { recent, push, clear }
}

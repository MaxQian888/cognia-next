import { useCallback, useEffect, useRef, useState } from "react"

import { loggers } from "@cognia/logging"

import { recordBrowserVisit } from "@/lib/db/browser-history"

export interface BrowserHistory {
  /** The back/forward stack, oldest first. */
  entries: string[]
  /** Index of the current entry in {@link entries}, or -1 when empty. */
  index: number
  /** Whether there is an entry before the current one. */
  canGoBack: boolean
  /** Whether there is an entry after the current one. */
  canGoForward: boolean
  /**
   * Record arriving at `url`: truncates anything ahead of the current entry,
   * exactly like a real browser. Consecutive duplicates collapse.
   */
  push: (url: string) => void
  /** Overwrite the current entry — a `history.replaceState` landed. */
  replace: (url: string) => void
  /** Step back one entry and return its URL, or null when there is none. */
  goBack: () => string | null
  /** Step forward one entry and return its URL, or null when there is none. */
  goForward: () => string | null
  /**
   * Move to an existing entry by URL without changing the stack — what the
   * page reports after a `popstate` it drove itself. Unknown or ambiguous URLs
   * are ignored rather than guessed at.
   */
  traverseTo: (url: string) => void
}

interface Stack {
  entries: string[]
  index: number
}

const EMPTY: Stack = { entries: [], index: -1 }

/**
 * The preview's back/forward stack, plus the most-recent-first list the
 * address-bar menu shows.
 *
 * Neither WKWebView nor WebView2 exposes `canGoBack` through Tauri — back and
 * forward are `window.history.back()` / `.forward()` evaluated in the page
 * (`src-tauri/src/browser/embedded.rs`) — so the enabled state of those two
 * buttons has to be modelled here. Doing it in the renderer rather than in the
 * injected overlay is what makes it survive a cross-origin navigation, which
 * wipes any page-side bookkeeping; it is also the same shape `BrowserWebFallback`
 * already maintained inline for its iframe, so both now share one implementation.
 *
 * In memory and per pane by design: this carries a navigation *position*, which
 * must not outlive the pane or come back stale after a reload. What DOES
 * outlive it is the list of places visited: every arrival is recorded into the
 * account's `browserHistory` table (`lib/db/browser-history.ts`), which is what
 * the address-bar menu reads through `useRecentPages`.
 */
export function useBrowserHistory(): BrowserHistory {
  const [stack, setStack] = useState<Stack>(EMPTY)
  // Mirrored in a ref so `goBack` / `goForward` can return the target address
  // to their caller synchronously. Reading it out of a `setState` updater does
  // not work: React defers the updater to render time, so the caller would
  // always see the pre-update value (or, under StrictMode, see it twice).
  const stackRef = useRef<Stack>(EMPTY)

  const commit = useCallback((next: Stack) => {
    stackRef.current = next
    setStack(next)
  }, [])

  const push = useCallback(
    (url: string) => {
      if (!url) return
      const prev = stackRef.current
      if (prev.entries[prev.index] === url) return
      const entries = [...prev.entries.slice(0, prev.index + 1), url]
      commit({ entries, index: entries.length - 1 })
    },
    [commit]
  )

  const replace = useCallback(
    (url: string) => {
      if (!url) return
      const prev = stackRef.current
      if (prev.index < 0) {
        commit({ entries: [url], index: 0 })
        return
      }
      if (prev.entries[prev.index] === url) return
      const entries = [...prev.entries]
      entries[prev.index] = url
      commit({ entries, index: prev.index })
    },
    [commit]
  )

  const step = useCallback(
    (delta: number): string | null => {
      const prev = stackRef.current
      const next = prev.index + delta
      if (next < 0 || next >= prev.entries.length) return null
      commit({ entries: prev.entries, index: next })
      return prev.entries[next] ?? null
    },
    [commit]
  )

  const goBack = useCallback(() => step(-1), [step])
  const goForward = useCallback(() => step(1), [step])

  const traverseTo = useCallback(
    (url: string) => {
      if (!url) return
      const prev = stackRef.current
      if (prev.entries[prev.index] === url) return
      // A URL that appears more than once cannot be resolved to a position, and
      // guessing would desync the stack from the page. Leave the index alone —
      // the address bar still follows the reported URL either way.
      const first = prev.entries.indexOf(url)
      if (first === -1 || first !== prev.entries.lastIndexOf(url)) return
      commit({ entries: prev.entries, index: first })
    },
    [commit]
  )

  // Record each arrival once it has committed — never from inside `push`,
  // which the web fallback calls while rendering to follow a host's request.
  const current = stack.index >= 0 ? (stack.entries[stack.index] ?? null) : null
  useEffect(() => {
    if (!current) return
    void recordBrowserVisit(current).catch((error: unknown) => {
      // Losing one history row must never interrupt browsing.
      loggers.store.warn("browser history write failed", { error: String(error) })
    })
  }, [current])

  return {
    entries: stack.entries,
    index: stack.index,
    canGoBack: stack.index > 0,
    canGoForward: stack.index >= 0 && stack.index < stack.entries.length - 1,
    push,
    replace,
    goBack,
    goForward,
    traverseTo,
  }
}

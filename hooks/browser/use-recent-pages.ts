"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { useCallback, useMemo } from "react"

import { loggers } from "@cognia/logging"

import { clearBrowserHistory, listRecentBrowserVisits } from "@/lib/db/browser-history"

/** How many visited pages the address-bar history menu lists. */
export const RECENT_PAGES_LIMIT = 25

export interface UseRecentPages {
  /** Visited addresses, most recent first — survives the pane and a restart. */
  recent: string[]
  /** Forget every visited page. Resolves false when the store refused. */
  clear: () => Promise<boolean>
}

/**
 * The built-in browser's recent pages, live from the account's
 * `browserHistory` table (written by `useBrowserHistory` on each arrival).
 *
 * Every surface reads the same list, so a page opened in the chat rail shows up
 * in `/browser`'s menu and on its empty state, and "Clear history" in any of
 * them clears it for all. The back/forward stack is untouched by a clear: it is
 * the open pane's position, not a record of where the user has been.
 */
export function useRecentPages(limit: number = RECENT_PAGES_LIMIT): UseRecentPages {
  const rows = useLiveQuery(() => listRecentBrowserVisits(limit), [limit], [])
  const recent = useMemo(() => (rows ?? []).map((row) => row.url), [rows])
  const clear = useCallback(async () => {
    try {
      await clearBrowserHistory()
      return true
    } catch (error) {
      loggers.store.warn("browser history clear failed", { error: String(error) })
      return false
    }
  }, [])
  return { recent, clear }
}

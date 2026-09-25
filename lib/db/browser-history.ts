/**
 * CRUD for `browserHistory` (schema v229) — pages visited in the built-in
 * browser.
 *
 * The back/forward stack in `useBrowserHistory` is a navigation *position*:
 * per pane, in memory, and it must not come back stale after a reload. This is
 * the other thing a browser keeps — the places you have been — which the
 * address bar's history menu and the empty pane's "recent" row offer, and which
 * therefore has to outlive the pane. Before this table the menu was derived
 * from the stack, so it forgot everything the moment the pane closed.
 *
 * One row per address (the id IS the address), so a revisit bumps `visitedAt`
 * and `visits` rather than adding a duplicate. http(s) only: `about:blank` and
 * the like are not places anyone wants to return to. Capped at
 * {@link MAX_BROWSER_HISTORY_ROWS}, trimmed oldest-first after each write.
 *
 * Device- and account-local on purpose: it lives in the account's own database
 * (so it is isolated per local account and goes with "clear all data"), it is
 * not in the companion sync set, and the portable backup leaves it behind — a
 * browsing history is not something to carry to another machine.
 */

import { getDb } from "./schema"

/** Rows kept before the oldest are trimmed. */
export const MAX_BROWSER_HISTORY_ROWS = 500

export interface BrowserHistoryRow {
  /** The visited address — also the primary key. */
  id: string
  url: string
  /** Most recent visit (ms epoch). */
  visitedAt: number
  /** How many times the address has been arrived at. */
  visits: number
}

/** The canonical form an address is stored under, or null when not recordable. */
export function browserHistoryKey(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  return parsed.toString()
}

/**
 * Record arriving at `url`. A revisit moves the row to the top instead of
 * inserting a second one. Addresses that are not http(s) are ignored.
 */
export async function recordBrowserVisit(url: string, now: number = Date.now()): Promise<void> {
  const key = browserHistoryKey(url)
  if (!key) return
  const db = getDb()
  await db.transaction("rw", db.browserHistory, async () => {
    const existing = await db.browserHistory.get(key)
    await db.browserHistory.put({
      id: key,
      url: key,
      visitedAt: now,
      visits: (existing?.visits ?? 0) + 1,
    })
    const overflow = (await db.browserHistory.count()) - MAX_BROWSER_HISTORY_ROWS
    if (overflow > 0) {
      const oldest = await db.browserHistory.orderBy("visitedAt").limit(overflow).primaryKeys()
      await db.browserHistory.bulkDelete(oldest)
    }
  })
}

/** The `limit` most recently visited addresses, newest first. */
export async function listRecentBrowserVisits(limit: number): Promise<BrowserHistoryRow[]> {
  return getDb().browserHistory.orderBy("visitedAt").reverse().limit(limit).toArray()
}

/** Forget every visited page — the history menu's "Clear history". */
export async function clearBrowserHistory(): Promise<void> {
  await getDb().browserHistory.clear()
}

/**
 * One-way signal for "the Dexie schema upgrade is stuck".
 *
 * `getDb()`'s `blocked` handler re-nudges other connections to yield; when the
 * cap is hit the upgrade will never proceed on its own. That state used to be a
 * lone `console.error` while the user stared at a loading spinner — the app
 * looked frozen and nothing on screen said why or what to do.
 *
 * A DOM CustomEvent (rather than a store) keeps `lib/db/schema.ts` free of React
 * and of any import that would drag the UI graph into the node-env test project.
 * Same shape as `lib/plugin/error-bus.ts`, so the subscriber side stays a
 * one-line `useEffect`.
 */

export const DB_UPGRADE_BLOCKED_EVENT = "cognia:db-upgrade-blocked" as const

export interface DbUpgradeBlockedDetail {
  /** Database name whose upgrade is stuck — shown in the dialog's detail line. */
  databaseName: string
  /** How many yield nudges went unanswered before giving up. */
  attempts: number
}

export type DbUpgradeBlockedHandler = (detail: DbUpgradeBlockedDetail) => void

/**
 * Announce that the upgrade gave up. Safe in any context — outside a browser
 * (node tests, SSR pre-render) the dispatch is skipped.
 */
export function dispatchDbUpgradeBlocked(detail: DbUpgradeBlockedDetail): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<DbUpgradeBlockedDetail>(DB_UPGRADE_BLOCKED_EVENT, { detail })
  )
}

/** Subscribe to the give-up signal. Returns an unsubscribe function. */
export function subscribeDbUpgradeBlocked(handler: DbUpgradeBlockedHandler): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<DbUpgradeBlockedDetail>).detail
    if (!detail) return
    handler(detail)
  }
  window.addEventListener(DB_UPGRADE_BLOCKED_EVENT, listener)
  return () => window.removeEventListener(DB_UPGRADE_BLOCKED_EVENT, listener)
}

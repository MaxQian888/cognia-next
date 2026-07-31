// Menu-driven usage-refresh bus. The tray dispatcher can't reach into a
// mounted React hook, so "Refresh usage" clicks funnel through this tiny
// emitter and `lib/tray/usage.ts:useTrayUsage` subscribes for as long as it
// is enabled. Kept dependency-free so the dispatcher (imported by node-env
// test suites) never drags the React/Dexie subscription stack with it.

const refreshListeners = new Set<() => void>()

/** Ask every mounted `useTrayUsage` to re-query provider limits now. */
export function requestTrayUsageRefresh(): void {
  for (const listener of Array.from(refreshListeners)) {
    try {
      listener()
    } catch {
      // A broken listener must not stop the rest from refreshing.
    }
  }
}

/** Subscribe to explicit refresh requests. Returns the unsubscriber. */
export function onTrayUsageRefreshRequest(listener: () => void): () => void {
  refreshListeners.add(listener)
  return () => refreshListeners.delete(listener)
}

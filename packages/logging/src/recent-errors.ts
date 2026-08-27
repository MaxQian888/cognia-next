import type { StructuredLogEntry } from "./types"

const MAX_RECENT_ERROR_LOGS = 100

let recentErrorLogs: StructuredLogEntry[] = []
const subscribers = new Set<() => void>()

function notifySubscribers(): void {
  for (const subscriber of subscribers) {
    subscriber()
  }
}

function isRecentErrorLevel(entry: StructuredLogEntry): boolean {
  return entry.level === "error" || entry.level === "fatal"
}

export function recordRecentErrorLog(entry: StructuredLogEntry): void {
  if (!isRecentErrorLevel(entry)) {
    return
  }

  recentErrorLogs = [entry, ...recentErrorLogs.filter((current) => current.id !== entry.id)].slice(
    0,
    MAX_RECENT_ERROR_LOGS
  )
  notifySubscribers()
}

export function getRecentErrorLogs(limit = MAX_RECENT_ERROR_LOGS): StructuredLogEntry[] {
  return recentErrorLogs.slice(0, limit)
}

/**
 * The buffer itself, by reference — a `useSyncExternalStore` snapshot.
 *
 * `getRecentErrorLogs` slices, so it hands back a fresh array on every call and
 * cannot be a snapshot getter (React would re-render forever). The buffer is
 * only ever *replaced*, never mutated in place, so its identity is a valid
 * snapshot: it changes exactly when subscribers are notified.
 *
 * This matters beyond tidiness. `recordRecentErrorLog` runs on the console
 * bridge's synchronous path, so a `console.error` from inside any component's
 * render notifies subscribers mid-render. A `useState` subscriber then trips
 * React's "Cannot update a component while rendering a different component";
 * `useSyncExternalStore` is the path that is allowed to be told mid-render.
 */
export function getRecentErrorLogsSnapshot(): StructuredLogEntry[] {
  return recentErrorLogs
}

export function clearRecentErrorLogs(): void {
  recentErrorLogs = []
  notifySubscribers()
}

export function subscribeRecentErrorLogs(listener: () => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

export function resetRecentErrorLogsForTest(): void {
  recentErrorLogs = []
  subscribers.clear()
}

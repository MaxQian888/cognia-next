import type { StructuredLogEntry } from "@/types/logging"

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

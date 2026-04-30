/**
 * Scheduler Format Utilities
 * Shared formatting functions for scheduler UI components
 */

/**
 * Format duration in milliseconds to a human-readable string
 */
export function formatDuration(ms: number | undefined): string {
  if (!ms) return "-"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) {
    const minutes = Math.floor(ms / 60000)
    const seconds = Math.round((ms % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.round((ms % 3600000) / 60000)
  return `${hours}h ${minutes}m`
}

/**
 * Format a Date as a relative time string (e.g., "3m", "2h", "5d")
 */
export function formatRelativeTime(
  date: Date | undefined,
  overrideLabels?: {
    overdue?: string
    lessThanMinute?: string
  }
): string {
  if (!date) return "-"

  const now = new Date()
  const diff = date.getTime() - now.getTime()

  if (diff < 0) return overrideLabels?.overdue || "Overdue"
  if (diff < 60000) return overrideLabels?.lessThanMinute || "< 1 min"
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000)
    return `${minutes}m`
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000)
    return `${hours}h`
  }
  const days = Math.floor(diff / 86400000)
  return `${days}d`
}

/**
 * Format next run time — short relative for near, full date for far
 */
export function formatNextRun(
  date: Date | undefined,
  overrideLabels?: {
    noSchedule?: string
    overdue?: string
    lessThanMinute?: string
  }
): string {
  if (!date) return overrideLabels?.noSchedule || "No schedule"

  const now = new Date()
  const diff = date.getTime() - now.getTime()

  if (diff < 0) return overrideLabels?.overdue || "Overdue"
  if (diff < 60000) return overrideLabels?.lessThanMinute || "< 1 min"
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000)
    return `${minutes}m`
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000)
    return `${hours}h`
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

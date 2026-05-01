/**
 * A2UI Date Formatting Utilities
 * Shared date formatting functions for A2UI components
 */

/**
 * Format a timestamp as a relative time string (e.g., "2h ago", "3d ago")
 */
export function formatRelativeTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  if (diff < 60000) return "just now"
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`

  return date.toLocaleDateString()
}

/**
 * Format a timestamp as an absolute localized date string
 */
export function formatAbsoluteTime(timestamp: number, locale?: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

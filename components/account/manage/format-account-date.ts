/**
 * Short, locale-aware calendar date for account metadata (created/updated).
 * Shared by the list rows and the profile tab so the format stays consistent.
 */
export function formatAccountDate(timestamp: number, locale?: string): string {
  return new Date(timestamp).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

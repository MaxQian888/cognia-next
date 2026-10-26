/** Small display helpers shared by the view's tabs. */

export function percent(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`
}

function safeLocale(locale: string): string {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0 ? locale : "en"
  } catch {
    return "en"
  }
}

export function formatDateTime(locale: string, ms: number): string {
  return new Intl.DateTimeFormat(safeLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(ms)
}

export function lineRange(startLine: number | undefined, endLine: number | undefined): string {
  if (startLine === undefined) return ""
  return endLine !== undefined && endLine !== startLine
    ? `${startLine}–${endLine}`
    : String(startLine)
}

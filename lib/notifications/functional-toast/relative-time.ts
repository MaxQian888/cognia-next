// Compact localized relative time for the functional-toast timeline.
// `Intl.RelativeTimeFormat` with `style: "narrow"` gives the shortest
// locale-correct form ("4h ago" / "4小时前" / "in 2d" / "2天后") without a
// per-locale string table. next-intl's `format.relativeTime` produces the
// long style ("4 hours ago"), which does not fit the timeline chips.

const UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
  { unit: "second", ms: 1000 },
]

const formatters = new Map<string, Intl.RelativeTimeFormat>()

function formatter(locale: string): Intl.RelativeTimeFormat {
  let rtf = formatters.get(locale)
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" })
    formatters.set(locale, rtf)
  }
  return rtf
}

/**
 * `dateMs` relative to `nowMs`, in the largest unit that yields a whole value
 * (45m → "45m ago", not "0h ago"). Negative deltas read as the past.
 */
export function relativeCompact(dateMs: number, nowMs: number, locale: string): string {
  const deltaMs = dateMs - nowMs
  const abs = Math.abs(deltaMs)
  for (const { unit, ms } of UNITS) {
    if (abs >= ms || unit === "second") {
      return formatter(locale).format(Math.round(deltaMs / ms), unit)
    }
  }
  return formatter(locale).format(0, "second")
}

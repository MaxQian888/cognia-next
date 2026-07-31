/**
 * Format a user turn's wall-clock timestamp for the conversation timeline.
 *
 * Same-day turns show only `HH:MM`; older turns gain a relative date prefix so
 * the rail's hover-scrub card (and the expanded sidebar) can distinguish early
 * vs. recent inputs in a long, multi-day conversation:
 *
 * - invalid / missing `ms`      → `""`
 * - same calendar day           → `14:32`
 * - yesterday                   → `Yesterday 14:32` (label injected from i18n)
 * - within the last 7 days      → `Mon 14:32` (locale short weekday)
 * - older                       → `Jun 21 14:32` (locale month/day, + year if it differs)
 *
 * Pure and side-effect free: `now` is injectable so tests are deterministic.
 */
export interface FormatTurnTimeOptions {
  /** Reference "now" in ms. Defaults to {@link Date.now}. */
  now?: number
  /** Localized word for "yesterday" (e.g. from `chat.timeline.yesterday`). */
  yesterdayLabel: string
  /** BCP-47 locale(s) for `Intl` formatting. Defaults to the runtime locale. */
  locale?: string | string[]
}

const MS_PER_DAY = 86_400_000

/** Midnight (local time) of the calendar day containing `d`, as epoch ms. */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function formatTurnTime(
  ms: number | undefined,
  { now = Date.now(), yesterdayLabel, locale }: FormatTurnTimeOptions
): string {
  if (ms == null || !Number.isFinite(ms)) return ""

  let date: Date
  let nowDate: Date
  let time: string
  try {
    date = new Date(ms)
    nowDate = new Date(now)
    time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
  } catch {
    return ""
  }

  // Whole calendar days between the two local midnights. Rounded so a DST shift
  // can't turn an exact day boundary into 0.999… days.
  const dayDiff = Math.round((startOfLocalDay(nowDate) - startOfLocalDay(date)) / MS_PER_DAY)

  if (dayDiff === 0) return time
  if (dayDiff === 1) return `${yesterdayLabel} ${time}`

  // Past week (but not today/yesterday): short weekday is the most scannable.
  if (dayDiff >= 2 && dayDiff <= 6) {
    return `${date.toLocaleDateString(locale, { weekday: "short" })} ${time}`
  }

  // Older, or any future timestamp: explicit date, with year only when it differs.
  const sameYear = date.getFullYear() === nowDate.getFullYear()
  const datePart = date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })
  return `${datePart} ${time}`
}

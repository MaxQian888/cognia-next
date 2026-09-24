import { differenceInCalendarDays } from "date-fns"

import { deviceTimeZone } from "@/lib/profile/timezone"

const DAY_MS = 86_400_000

/**
 * Calendar arithmetic in the zone the list *prints* in.
 *
 * `next-intl` formats every row in the provider's `timeZone` (the user's zone,
 * `components/providers/locale-gate.tsx`), so "is this today?" has to be asked
 * in that same zone — deciding "today" in one zone and printing the clock time
 * in another is how 14:32 local rendered as 06:32. `date-fns` only knows the
 * device's local zone, which is the fast and overwhelmingly common case; a
 * profile override that names another zone goes through `Intl` instead.
 */
interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

// One formatter per zone (constructing `Intl.DateTimeFormat` is the expensive
// part). `null` caches "not a zone this runtime knows", so a bad profile value
// costs one failed construction rather than one per row.
const zonedFormatters = new Map<string, Intl.DateTimeFormat | null>()

function zonedFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = zonedFormatters.get(timeZone)
  if (cached !== undefined) return cached
  let formatter: Intl.DateTimeFormat | null
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
  } catch {
    formatter = null
  }
  zonedFormatters.set(timeZone, formatter)
  return formatter
}

// Read once: the device zone only moves when the OS setting does, and the
// provider re-resolves it on the next settings load anyway.
let cachedDeviceZone: string | undefined

/**
 * The formatter to use for `timeZone`, or `null` when the device's own local
 * calendar already answers the question (no zone given, the device zone, or a
 * zone this runtime cannot resolve).
 */
function foreignZoneFormatter(timeZone: string | undefined): Intl.DateTimeFormat | null {
  if (!timeZone) return null
  cachedDeviceZone ??= deviceTimeZone()
  if (timeZone === cachedDeviceZone) return null
  return zonedFormatter(timeZone)
}

function zonedParts(ms: number, formatter: Intl.DateTimeFormat): ZonedParts {
  const parts: ZonedParts = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 }
  for (const part of formatter.formatToParts(ms)) {
    if (part.type in parts) parts[part.type as keyof ZonedParts] = Number(part.value)
  }
  return parts
}

/** Days since the epoch for the calendar date `ms` falls on in the formatter's zone. */
function zonedDayOrdinal(ms: number, formatter: Intl.DateTimeFormat): number {
  const { year, month, day } = zonedParts(ms, formatter)
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS)
}

/**
 * Whole calendar days from `timestamp` to `now` in `timeZone` (negative when
 * `timestamp` is in the future). Omit the zone for the device's local calendar.
 */
export function calendarDaysBetween(now: number, timestamp: number, timeZone?: string): number {
  const formatter = foreignZoneFormatter(timeZone)
  if (!formatter) return differenceInCalendarDays(now, timestamp)
  return zonedDayOrdinal(now, formatter) - zonedDayOrdinal(timestamp, formatter)
}

/** The calendar year `ms` falls in, in `timeZone` (device-local when omitted). */
export function calendarYearOf(ms: number, timeZone?: string): number {
  const formatter = foreignZoneFormatter(timeZone)
  return formatter ? zonedParts(ms, formatter).year : new Date(ms).getFullYear()
}

/**
 * A number that changes exactly when the calendar day does, in `timeZone` —
 * the key a day-granular clock compares to decide whether it has to tick.
 */
export function calendarDayKey(ms: number, timeZone?: string): number {
  const formatter = foreignZoneFormatter(timeZone)
  if (formatter) return zonedDayOrdinal(ms, formatter)
  const date = new Date(ms)
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

/**
 * Milliseconds from `now` until the next calendar day starts in `timeZone`.
 *
 * Read off the wall clock, so on the one day a year a DST switch sits between
 * now and midnight it can be an hour off in either direction. Callers that
 * schedule on it must re-check {@link calendarDayKey} when the timer fires and
 * cap the wait (see `useConversationDayClock`), which turns the error into at
 * most one extra, early wake-up.
 */
export function msUntilNextCalendarDay(now: number, timeZone?: string): number {
  const formatter = foreignZoneFormatter(timeZone)
  if (!formatter) {
    const date = new Date(now)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - now
  }
  const { hour, minute, second } = zonedParts(now, formatter)
  const intoDay = ((hour * 60 + minute) * 60 + second) * 1000 + (((now % 1000) + 1000) % 1000)
  return Math.max(1, DAY_MS - intoDay)
}

/**
 * Compact, locale-agnostic timestamp shape for a conversation-list row.
 *
 * The sidebar is ~256px wide, so a full relative phrase ("about 3 hours ago")
 * eats the title it is supposed to annotate. Mail clients solved this long ago:
 * show the *most specific field that is still unambiguous* — a clock time for
 * today, a weekday inside the last week, a date beyond that, and the year only
 * once it stops being obvious.
 *
 * Pure and clock-injected on purpose: this decides only the *shape*. Turning a
 * shape into text is `next-intl`'s `format.dateTime` at the call site, so every
 * locale gets its own conventions (and zh-CN never sees an English abbreviation
 * — the defect that killed the previous hand-rolled "3m"/"2d" helper).
 */
export type ConversationTimestampShape = "time" | "weekday" | "date" | "dateWithYear"

/**
 * `Intl.DateTimeFormat` options per shape — hoisted so identity stays stable.
 *
 * `as const satisfies` rather than an annotation: `next-intl` accepts a
 * *narrower* options type than `Intl.DateTimeFormatOptions` (no `shortOffset`
 * time zone names, among others), so a widened annotation here would not be
 * assignable at the call site.
 */
export const CONVERSATION_TIMESTAMP_FORMATS = {
  time: { hour: "numeric", minute: "2-digit" },
  weekday: { weekday: "short" },
  date: { month: "short", day: "numeric" },
  dateWithYear: { year: "numeric", month: "numeric", day: "numeric" },
} as const satisfies Record<ConversationTimestampShape, Intl.DateTimeFormatOptions>

/**
 * Pick the timestamp shape for one row.
 *
 * Boundaries are *calendar* days, not 24h windows: a message from 23:50 last
 * night reads as "yesterday" at 00:10, which is what a person means. Future
 * timestamps (clock skew between devices, cf. `dateBucketFor`) clamp to `time`
 * rather than rendering a date from the future.
 *
 * `timeZone` must be the zone the text is then formatted in (next-intl's
 * `useTimeZone()`), so the shape and the printed value describe the same
 * calendar; omitted, both are the device's local zone.
 */
export function conversationTimestampShape(
  now: number,
  timestamp: number,
  timeZone?: string
): ConversationTimestampShape {
  const days = calendarDaysBetween(now, timestamp, timeZone)
  if (days <= 0) return "time"
  if (days < 7) return "weekday"
  // Same calendar year → the year is redundant noise in a 256px rail.
  if (calendarYearOf(now, timeZone) === calendarYearOf(timestamp, timeZone)) return "date"
  return "dateWithYear"
}

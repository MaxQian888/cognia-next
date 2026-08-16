import { differenceInCalendarDays } from "date-fns"

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
 */
export function conversationTimestampShape(
  now: number,
  timestamp: number
): ConversationTimestampShape {
  const days = differenceInCalendarDays(now, timestamp)
  if (days <= 0) return "time"
  if (days < 7) return "weekday"
  // Same calendar year → the year is redundant noise in a 256px rail.
  if (new Date(now).getFullYear() === new Date(timestamp).getFullYear()) return "date"
  return "dateWithYear"
}

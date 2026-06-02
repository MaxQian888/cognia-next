/**
 * Cron Expression Parser
 *
 * Thin wrapper around the `cron-parser` library (OCPS-compliant: optional
 * seconds, `L`, `1L`-`7L`, `#`, ranges/steps/lists/names, predefined macros,
 * timezone + DST). This module keeps a stable, app-specific API surface — the
 * ~11 consumers across scheduler / twin / wiki / workflow-editor UI call these
 * functions and must not change.
 *
 * History: this file used to hand-roll a 5-field parser with a 4-year
 * minute-by-minute search loop, duplicating what `cron-parser` (already a
 * dependency) does correctly. We now delegate to the library and only retain
 * the field-splitting + human-readable describer that the library does not
 * provide.
 *
 * Parity notes vs the old hand-rolled implementation:
 *   - When no `timezone` is supplied we default to the host's local zone so
 *     "0 9 * * *" still means 9am wall-clock locally (the library otherwise
 *     defaults to UTC).
 *   - DOM/DOW both-restricted uses OR/union semantics (Vixie cron), matching
 *     the old behavior — we do NOT enable the library's `strict` mode.
 *   - Impossible expressions (e.g. `0 0 30 2 *`) and parse errors map to
 *     `null` so `calculateNextRunTime` degrades to `undefined` as before.
 *   - The `W` (nearest-weekday) modifier is intentionally rejected with a
 *     clear message: the library does not support it. (Upgrade path: `croner`.)
 */

import { CronExpressionParser } from "cron-parser"

import type { CronParts } from "@/types/scheduler"

/**
 * Predefined macros, mirroring `cron-parser`'s `PredefinedExpressions` so that
 * `parseCronExpression`/`describeCronExpression` agree with what the library
 * actually schedules. Keys are lowercase for case-insensitive matching.
 */
const CRON_MACROS: Record<string, string> = {
  "@yearly": "0 0 0 1 1 *",
  "@annually": "0 0 0 1 1 *",
  "@monthly": "0 0 0 1 * *",
  "@weekly": "0 0 0 * * 0",
  "@daily": "0 0 0 * * *",
  "@hourly": "0 0 * * * *",
  "@minutely": "0 * * * * *",
  "@secondly": "* * * * * *",
  "@weekdays": "0 0 0 * * 1-5",
  "@weekends": "0 0 0 * * 0,6",
}

/** The host's IANA timezone, used when a caller omits `timezone`. */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Detect the unsupported `W` (nearest-weekday) modifier. */
function usesNearestWeekday(expression: string): boolean {
  return /(^|[\s,/-])(\d{1,2}|L)?W\b/i.test(expression)
}

/**
 * Expand a leading macro (`@daily`, …) to its canonical field expression.
 * Returns the input unchanged when it is not a macro.
 */
function expandMacro(expression: string): string {
  const trimmed = expression.trim()
  if (trimmed.startsWith("@")) {
    return CRON_MACROS[trimmed.toLowerCase()] ?? trimmed
  }
  return trimmed
}

/**
 * Parse a cron expression into its named parts. Accepts 5-field
 * (`min hour dom month dow`) and 6-field (`sec min hour dom month dow`) forms,
 * plus predefined macros (which expand to a 6-field form). Returns `null` for
 * any other shape (4-field, 7-field with year, empty, or unparseable).
 *
 * `seconds` is populated only for 6-field/macro input; 5-field input omits it
 * so existing 5-field round-trips stay byte-identical.
 */
export function parseCronExpression(expression: string): CronParts | null {
  if (!expression || !expression.trim()) return null
  const expanded = expandMacro(expression)
  const parts = expanded.split(/\s+/)

  if (parts.length === 5) {
    return {
      minute: parts[0],
      hour: parts[1],
      dayOfMonth: parts[2],
      month: parts[3],
      dayOfWeek: parts[4],
    }
  }

  if (parts.length === 6) {
    return {
      seconds: parts[0],
      minute: parts[1],
      hour: parts[2],
      dayOfMonth: parts[3],
      month: parts[4],
      dayOfWeek: parts[5],
    }
  }

  return null
}

/**
 * Validate a cron expression by delegating to the library parser. Rejects the
 * unsupported `W` modifier and 7-field (year) expressions — neither is
 * representable in the app's `CronParts`/trigger model — with explicit errors.
 */
export function validateCronExpression(expression: string): { valid: boolean; error?: string } {
  if (!expression || !expression.trim()) {
    return { valid: false, error: "Invalid format: empty expression" }
  }

  if (usesNearestWeekday(expression)) {
    return {
      valid: false,
      error: "The 'W' (nearest weekday) modifier is not supported",
    }
  }

  const expanded = expandMacro(expression)
  const fieldCount = expanded.split(/\s+/).length
  // The library accepts 7-field (with a year) expressions, but the app model
  // has no year field — reject for representational consistency.
  if (!expanded.startsWith("@") && fieldCount > 6) {
    return {
      valid: false,
      error: "The year field (7-field cron) is not supported",
    }
  }

  try {
    CronExpressionParser.parse(expression, { tz: localTimezone() })
    return { valid: true }
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "Invalid cron expression",
    }
  }
}

/**
 * Get the next occurrence of a cron expression after `fromDate`.
 * @param timezone Optional IANA timezone. When omitted, the host's local zone
 *                 is used so wall-clock fields are interpreted locally.
 * @returns The next fire `Date`, or `null` for invalid/unschedulable input.
 */
export function getNextCronTime(
  expression: string,
  fromDate: Date = new Date(),
  timezone?: string
): Date | null {
  if (usesNearestWeekday(expression)) return null
  try {
    const interval = CronExpressionParser.parse(expression, {
      currentDate: fromDate,
      tz: timezone ?? localTimezone(),
    })
    return interval.next().toDate()
  } catch {
    return null
  }
}

/**
 * Get multiple upcoming occurrences of a cron expression.
 */
export function getNextCronTimes(
  expression: string,
  count: number,
  fromDate: Date = new Date(),
  timezone?: string
): Date[] {
  if (count <= 0) return []
  if (usesNearestWeekday(expression)) return []
  try {
    const interval = CronExpressionParser.parse(expression, {
      currentDate: fromDate,
      tz: timezone ?? localTimezone(),
    })
    return interval.take(count).map((d) => d.toDate())
  } catch {
    return []
  }
}

/**
 * Optional translator passed to {@link describeCronExpression}. Compatible with
 * a next-intl `useTranslations()` / `getTranslations()` return value scoped to
 * the `scheduler.cronDescribe` namespace. When omitted, English fallbacks are
 * used (keeps the function usable outside React / server contexts).
 */
export type CronDescribeTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/**
 * Human-readable description of a cron expression. The library does not provide
 * descriptions, so we build one from the parsed parts. Pass an optional
 * translator (`t`) to localize; without it, English is produced.
 */
export function describeCronExpression(expression: string, t?: CronDescribeTranslator): string {
  const parts = parseCronExpression(expression)
  const tr: CronDescribeTranslator = t ?? ((_key, values) => fallbackDescribe(_key, values))
  if (!parts) return tr("invalid")

  const segments: string[] = []

  // Seconds (only when present and meaningful).
  if (parts.seconds && parts.seconds !== "0" && parts.seconds !== "*") {
    if (parts.seconds.startsWith("*/")) {
      segments.push(tr("everyNSeconds", { n: parts.seconds.slice(2) }))
    } else {
      segments.push(tr("atSecond", { value: parts.seconds }))
    }
  }

  // Minute.
  if (parts.minute === "*") {
    segments.push(tr("everyMinute"))
  } else if (parts.minute.startsWith("*/")) {
    segments.push(tr("everyNMinutes", { n: parts.minute.slice(2) }))
  } else {
    segments.push(tr("atMinute", { value: parts.minute }))
  }

  // Hour.
  if (parts.hour === "*") {
    segments.push(tr("ofEveryHour"))
  } else if (parts.hour.startsWith("*/")) {
    segments.push(tr("everyNHours", { n: parts.hour.slice(2) }))
  } else {
    segments.push(tr("atHour", { value: parts.hour }))
  }

  // Day of month (incl. `L` last-day).
  if (parts.dayOfMonth !== "*") {
    if (/\bL\b/i.test(parts.dayOfMonth)) {
      segments.push(tr("onLastDay"))
    } else if (parts.dayOfMonth.startsWith("*/")) {
      segments.push(tr("everyNDays", { n: parts.dayOfMonth.slice(2) }))
    } else {
      segments.push(tr("onDay", { value: parts.dayOfMonth }))
    }
  }

  // Month.
  if (parts.month !== "*") {
    if (parts.month.startsWith("*/")) {
      segments.push(tr("everyNMonths", { n: parts.month.slice(2) }))
    } else {
      const monthNum = parseInt(parts.month, 10)
      if (!isNaN(monthNum) && monthNum >= 1 && monthNum <= 12) {
        segments.push(tr("inMonth", { month: MONTH_LABELS[monthNum - 1] }))
      }
    }
  }

  // Day of week (incl. nth `#` and last `L`).
  if (parts.dayOfWeek !== "*") {
    if (parts.dayOfWeek === "1-5") {
      segments.push(tr("onWeekdays"))
    } else if (parts.dayOfWeek === "0,6" || parts.dayOfWeek === "6,0") {
      segments.push(tr("onWeekends"))
    } else if (parts.dayOfWeek.includes("#")) {
      const [dow, nth] = parts.dayOfWeek.split("#")
      const dayNum = parseInt(dow, 10)
      const dayLabel = !isNaN(dayNum) && dayNum >= 0 && dayNum <= 6 ? DAY_LABELS[dayNum] : dow
      segments.push(tr("onNthWeekday", { nth, day: dayLabel }))
    } else if (/\dL$/i.test(parts.dayOfWeek)) {
      const dayNum = parseInt(parts.dayOfWeek, 10)
      const dayLabel =
        !isNaN(dayNum) && dayNum >= 0 && dayNum <= 6 ? DAY_LABELS[dayNum] : parts.dayOfWeek
      segments.push(tr("onLastWeekday", { day: dayLabel }))
    } else {
      const dayNum = parseInt(parts.dayOfWeek, 10)
      if (!isNaN(dayNum) && dayNum >= 0 && dayNum <= 6) {
        segments.push(tr("onDayOfWeek", { day: DAY_LABELS[dayNum] }))
      }
    }
  }

  return segments.join(" ")
}

/** English fallback used when no translator is provided. */
function fallbackDescribe(key: string, values?: Record<string, string | number>): string {
  switch (key) {
    case "invalid":
      return "Invalid expression"
    case "everyNSeconds":
      return `every ${values?.n} seconds`
    case "atSecond":
      return `at second ${values?.value}`
    case "everyMinute":
      return "every minute"
    case "everyNMinutes":
      return `every ${values?.n} minutes`
    case "atMinute":
      return `at minute ${values?.value}`
    case "ofEveryHour":
      return "of every hour"
    case "everyNHours":
      return `every ${values?.n} hours`
    case "atHour":
      return `at ${values?.value}:00`
    case "onLastDay":
      return "on the last day of the month"
    case "everyNDays":
      return `every ${values?.n} days`
    case "onDay":
      return `on day ${values?.value}`
    case "everyNMonths":
      return `every ${values?.n} months`
    case "inMonth":
      return `in ${values?.month}`
    case "onWeekdays":
      return "on weekdays"
    case "onWeekends":
      return "on weekends"
    case "onNthWeekday":
      return `on the ${values?.nth} occurrence of ${values?.day}`
    case "onLastWeekday":
      return `on the last ${values?.day} of the month`
    case "onDayOfWeek":
      return `on ${values?.day}`
    default:
      return key
  }
}

/**
 * Format a cron expression for display. Emits 6 fields when `seconds` is
 * present, else 5 — so a 5-field round-trip is byte-identical.
 */
export function formatCronExpression(parts: CronParts): string {
  const tail = `${parts.minute} ${parts.hour} ${parts.dayOfMonth} ${parts.month} ${parts.dayOfWeek}`
  return parts.seconds !== undefined ? `${parts.seconds} ${tail}` : tail
}

/**
 * Check whether a given date matches a cron expression (minute granularity in
 * the supplied/local timezone). No production consumer beyond tests; kept for
 * API stability.
 */
export function matchesCronExpression(expression: string, date: Date, timezone?: string): boolean {
  if (!validateCronExpression(expression).valid) return false
  const target = new Date(date)
  target.setSeconds(0, 0)
  try {
    const interval = CronExpressionParser.parse(expression, {
      currentDate: new Date(target.getTime() - 1000),
      tz: timezone ?? localTimezone(),
    })
    const next = interval.next().toDate()
    next.setSeconds(0, 0)
    return next.getTime() === target.getTime()
  } catch {
    return false
  }
}

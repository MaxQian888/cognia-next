/**
 * Number and duration formatting shared by every goal surface (ADR-0019).
 *
 * Three components each carried their own `kfmt` and the console card printed
 * elapsed time as a raw minute count ("30240 m"). These helpers are the one
 * read side: token counts compact through `Intl.NumberFormat` so the suffix is
 * the locale's own ("42K", "4.2万"), and durations pick the largest whole unit
 * and let `Intl` spell it ("3 days", "3天").
 */

/** Compact token count in the given locale — `42000` → "42K" / "4.2万". */
export function formatGoalTokens(tokens: number, locale?: string): string {
  const value = Number.isFinite(tokens) ? Math.max(0, tokens) : 0
  // One fraction digit everywhere: "42K" needs none, but the same value in
  // zh-CN is "4.2万", and rounding that to "4万" loses a fifth of it.
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)
}

/** The unit a duration is shown in, largest first. */
export type GoalDurationUnit = "day" | "hour" | "minute" | "second"

export interface GoalDurationParts {
  value: number
  unit: GoalDurationUnit
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Split a duration into the largest unit that still reads as a whole number of
 * something: under a minute is seconds, under an hour minutes, under two days
 * hours (so "36 hours" stays more useful than "1 day"), otherwise days.
 */
export function goalDurationParts(ms: number): GoalDurationParts {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (safe < MINUTE) return { value: Math.floor(safe / 1000), unit: "second" }
  if (safe < HOUR) return { value: Math.floor(safe / MINUTE), unit: "minute" }
  if (safe < 2 * DAY) return { value: Math.floor(safe / HOUR), unit: "hour" }
  return { value: Math.floor(safe / DAY), unit: "day" }
}

/** Localized duration — `3 * 3600_000` → "3 hr" / "3小时". */
export function formatGoalDuration(ms: number, locale?: string): string {
  const { value, unit } = goalDurationParts(ms)
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
  }).format(value)
}

/**
 * How long a goal has run: to `endedAt` for a finished goal, to `now` for an
 * open one. Never negative, even against a clock that moved backwards.
 */
export function goalRunDurationMs(
  goal: { createdAt: number; endedAt?: number },
  now: number
): number {
  const end = goal.endedAt ?? now
  return Math.max(0, end - goal.createdAt)
}

/** Share of a budget used, clamped to 0–100. A non-positive budget reads 0. */
export function goalBudgetPercent(used: number, max: number): number {
  if (!(max > 0)) return 0
  return Math.min(100, Math.max(0, (used / max) * 100))
}

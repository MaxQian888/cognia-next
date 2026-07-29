/**
 * Date headers for the expanded conversation timeline.
 *
 * A long-running conversation is resumed across days, and the panel's rows carry
 * only a time ("14:32"), so a hundred rows of bare clock times give no sense of
 * when anything happened. Marking where each calendar day starts turns the list
 * into something you can navigate by memory ("it was Tuesday afternoon").
 *
 * Returns a sparse map — only the turns that OPEN a day get a header — so the
 * caller can render it inline above a row and keep working with plain turn
 * indices. Building a merged header/row list instead would break the panel's
 * virtualizer, which indexes into the turns array.
 *
 * Pure and side-effect free: `now` is injectable so tests are deterministic.
 */

import type { TimelineTurn } from "./use-timeline-turns"

export interface TurnDateHeaderOptions {
  /** Reference "now" in ms. Defaults to {@link Date.now}. */
  now?: number
  /** Localized "Today" (e.g. `chat.timeline.today`). */
  todayLabel: string
  /** Localized "Yesterday" (e.g. `chat.timeline.yesterday`). */
  yesterdayLabel: string
  /** BCP-47 locale(s) for `Intl` formatting. Defaults to the runtime locale. */
  locale?: string | string[]
}

const MS_PER_DAY = 86_400_000

/** Midnight (local time) of the calendar day containing `d`, as epoch ms. */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Header text for the day containing `ms`, or `null` if the timestamp is
 * unusable. Mirrors `formatTurnTime`'s vocabulary so a row reading "Yesterday
 * 14:32" sits under a header reading "Yesterday", not a bare date.
 */
export function formatDateHeader(
  ms: number,
  { now = Date.now(), todayLabel, yesterdayLabel, locale }: TurnDateHeaderOptions
): string | null {
  if (!Number.isFinite(ms)) return null
  let date: Date
  let nowDate: Date
  try {
    date = new Date(ms)
    nowDate = new Date(now)
  } catch {
    return null
  }
  const dayDiff = Math.round((startOfLocalDay(nowDate) - startOfLocalDay(date)) / MS_PER_DAY)
  if (dayDiff === 0) return todayLabel
  if (dayDiff === 1) return yesterdayLabel

  const sameYear = date.getFullYear() === nowDate.getFullYear()
  try {
    return date.toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
      ...(dayDiff >= 2 && dayDiff <= 6 ? { weekday: "short" } : {}),
    })
  } catch {
    return null
  }
}

/**
 * Map of turn index → date header, containing only the turns that open a new
 * calendar day.
 *
 * Turns with no timestamp (the one the user just typed, not yet persisted) are
 * skipped rather than grouped under "unknown": they always sit at the end of
 * the day that is already on screen, so a header there would be noise.
 */
export function turnDateHeaders(
  turns: readonly TimelineTurn[],
  options: TurnDateHeaderOptions
): Map<number, string> {
  const headers = new Map<number, string>()
  let currentDay: number | null = null

  for (let index = 0; index < turns.length; index++) {
    const time = turns[index]?.time
    if (time == null || !Number.isFinite(time)) continue
    const day = startOfLocalDay(new Date(time))
    if (day === currentDay) continue
    currentDay = day
    const label = formatDateHeader(time, options)
    if (label != null) headers.set(index, label)
  }

  return headers
}

/**
 * The day label in force at `index` — the nearest header at or before it.
 *
 * Needed because the inline headers cannot stick under virtualization: each
 * row is `transform`-positioned, and a transformed ancestor becomes the
 * containing block for `position: sticky`, so an inline header sticks to its
 * own 40px row. The panel pins this value above the list instead, which is the
 * only branch where grouping actually matters (>40 turns).
 *
 * Returns null before the first header — a turn with no timestamp can sort
 * ahead of every dated one.
 */
export function dateHeaderAtOrBefore(
  headers: ReadonlyMap<number, string>,
  index: number
): string | null {
  let current: string | null = null
  for (const [headerIndex, label] of headers) {
    // `turnDateHeaders` inserts in ascending index order, so the first entry
    // past `index` means every later one is too.
    if (headerIndex > index) break
    current = label
  }
  return current
}

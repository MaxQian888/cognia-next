/**
 * The one agenda (ADR-0179 §3).
 *
 * The calendar, the timeline and the "upcoming" list were the same
 * occurrences grouped three ways. This is the single grouping the overview
 * renders: day buckets for the next window, plus per-day counts so a month
 * picker can show density without a second projection.
 */

import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

import {
  computeUnifiedOccurrences,
  countOccurrencesByDay,
  groupOccurrencesByDay,
  type Occurrence,
  type OccurrenceDay,
} from "./upcoming-occurrences"

export const AGENDA_DAYS = 14

/**
 * Per-task enumeration cap for the agenda: one fire every five minutes over
 * the whole window. The generic projection caps at 100, which a five-minute
 * task exhausts in eight hours and then reports every later day as idle.
 * Tasks denser than this (a one-minute interval) still under-count past the
 * point the cap is reached; the density row is a guide, not a ledger.
 */
export const AGENDA_MAX_PER_TASK = AGENDA_DAYS * 288

/** One agenda row: an item's first fire that day and how many follow it. */
export interface AgendaEntry {
  /** The first occurrence of the item that day. */
  first: Occurrence
  /** The last occurrence that day (equals `first` when `count` is 1). */
  last: Occurrence
  /** Fires of this item that day. */
  count: number
}

export interface Agenda {
  days: OccurrenceDay[]
  /** Every projected occurrence in the window, soonest first. */
  occurrences: Occurrence[]
  /** `YYYY-MM-DD` → count, for a density view. */
  countsByDay: Map<string, number>
  /** The soonest occurrence, or `undefined` when nothing is scheduled. */
  next?: Occurrence
}

export function buildAgenda(
  items: readonly UnifiedScheduledItem[],
  options: { now: number; days?: number; maxPerTask?: number }
): Agenda {
  const occurrences = computeUnifiedOccurrences(items, {
    from: new Date(options.now),
    days: options.days ?? AGENDA_DAYS,
    maxPerTask: options.maxPerTask ?? AGENDA_MAX_PER_TASK,
  }).sort((a, b) => a.date.getTime() - b.date.getTime())
  return {
    days: groupOccurrencesByDay(occurrences),
    occurrences,
    countsByDay: countOccurrencesByDay(occurrences),
    next: occurrences[0],
  }
}

/**
 * Collapse a day's occurrences into one row per item, in order of each
 * item's first fire. A five-minute task is one line ("×288, until 23:55"),
 * not 288 lines that bury the daily backup beneath them.
 */
export function groupDayByItem(day: OccurrenceDay): AgendaEntry[] {
  const byItem = new Map<string, AgendaEntry>()
  for (const occurrence of day.occurrences) {
    const entry = byItem.get(occurrence.taskId)
    if (entry) {
      entry.count += 1
      entry.last = occurrence
    } else {
      byItem.set(occurrence.taskId, { first: occurrence, last: occurrence, count: 1 })
    }
  }
  return [...byItem.values()]
}

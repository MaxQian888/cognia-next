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
    maxPerTask: options.maxPerTask,
  }).sort((a, b) => a.date.getTime() - b.date.getTime())
  return {
    days: groupOccurrencesByDay(occurrences),
    occurrences,
    countsByDay: countOccurrencesByDay(occurrences),
    next: occurrences[0],
  }
}

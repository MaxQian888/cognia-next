/**
 * The order of the scheduler list (ADR-0179 §4).
 *
 * The list is flat, so its order is the only structure it has. What needs the
 * user comes first, then what is running, then whatever fires soonest, and a
 * name tie-break so two idle items never swap places between renders.
 */

import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

import { attentionRank, type AttentionSignal } from "./attention"

export interface ListOrderContext {
  /** The one signal each item shows, from `itemAttention`. */
  signalByItem: ReadonlyMap<string, AttentionSignal | null>
  /** The clock, so a next run in the past sorts as overdue rather than soon. */
  now: number
}

function nextRunKey(item: UnifiedScheduledItem, now: number): number {
  const next = item.nextRunAt
  if (next === undefined) return Number.POSITIVE_INFINITY
  // Overdue items fire "now": they sort ahead of every future run but keep
  // their own order among themselves.
  return next < now ? now - 1 + (next % 1) : next
}

export function compareListItems(
  a: UnifiedScheduledItem,
  b: UnifiedScheduledItem,
  context: ListOrderContext
): number {
  const byAttention =
    attentionRank(context.signalByItem.get(a.unifiedId) ?? null) -
    attentionRank(context.signalByItem.get(b.unifiedId) ?? null)
  if (byAttention !== 0) return byAttention
  const byNext = nextRunKey(a, context.now) - nextRunKey(b, context.now)
  if (byNext !== 0 && Number.isFinite(byNext)) return byNext
  if (byNext !== 0) return Number.isFinite(nextRunKey(a, context.now)) ? -1 : 1
  return a.name.localeCompare(b.name)
}

/** A sorted copy; the input is never mutated. */
export function orderListItems(
  items: readonly UnifiedScheduledItem[],
  context: ListOrderContext
): UnifiedScheduledItem[] {
  return items.slice().sort((a, b) => compareListItems(a, b, context))
}

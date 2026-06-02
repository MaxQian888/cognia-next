// Burst coalescing (ADR-0042, Novu digest model). Pure: decide whether a new
// input bumps an existing same-`dedupeKey` record or inserts a fresh one, and
// build the bump patch. Two windows:
//   • REGULAR  — fixed window measured from the existing record's first event
//                (`createdAt`); after it lapses, a new record starts.
//   • BACKOFF  — window resets on each event; any match within `updatedAt`
//                recency keeps coalescing (opt-in via `coalesceBackoff`).
// The DB lookup (`findByDedupeKey`) already filters by `updatedAt >= now-window`;
// this module decides REGULAR's extra `createdAt` cap and the merge.

import type { NotificationRecord, NotificationLevel } from "@/types/notifications"
import { NOTIFICATION_LEVEL_RANK } from "@/types/notifications"

export const DEFAULT_COALESCE_WINDOW_MS = 45_000

/** Earliest `updatedAt` a record may have to still be coalescable at `now`. */
export function coalesceSince(now: number, windowMs = DEFAULT_COALESCE_WINDOW_MS): number {
  return now - windowMs
}

export interface CoalesceContext {
  now: number
  windowMs?: number
  backoff?: boolean
}

/**
 * Decide insert vs bump given the candidate found by `findByDedupeKey`.
 * `existing` is `undefined` when no recent same-key record exists.
 */
export function decideCoalesce(
  existing: NotificationRecord | undefined,
  ctx: CoalesceContext
): "insert" | "bump" {
  if (!existing) return "insert"
  if (ctx.backoff) return "bump"
  const windowMs = ctx.windowMs ?? DEFAULT_COALESCE_WINDOW_MS
  // REGULAR: also require the FIRST event to be within the window.
  return ctx.now - existing.createdAt <= windowMs ? "bump" : "insert"
}

export interface BumpInput {
  title: string
  body?: string
  level: NotificationLevel
  href?: string
  icon?: string
  directed?: boolean
  meta?: Record<string, unknown>
}

/**
 * Merge a repeat event into an existing record: increment `count`, refresh
 * content + timestamp, re-surface as unseen, and escalate level/directed
 * (never downgrade — a later error in a burst should not be masked by an info).
 */
export function buildBumpPatch(
  existing: NotificationRecord,
  input: BumpInput,
  now: number
): Partial<NotificationRecord> {
  const escalatedLevel =
    NOTIFICATION_LEVEL_RANK[input.level] > NOTIFICATION_LEVEL_RANK[existing.level]
      ? input.level
      : existing.level
  return {
    count: existing.count + 1,
    updatedAt: now,
    title: input.title,
    body: input.body,
    level: escalatedLevel,
    href: input.href ?? existing.href,
    icon: input.icon ?? existing.icon,
    directed: existing.directed || input.directed === true,
    readState: "unseen",
    snoozedUntil: undefined,
    meta: input.meta ?? existing.meta,
  }
}

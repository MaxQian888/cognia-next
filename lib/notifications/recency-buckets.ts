// Recency bucketing for the notification center (ADR-0042). Splits an already
// newest-first list of records into Today / Yesterday / Earlier sections so the
// panel can render dated headers. Pure — `now` is injected so it's testable and
// uses the local-day boundary (matches how users read "today").

import type { NotificationRecord } from "@/types/notifications"

export type RecencyBucketKey = "today" | "yesterday" | "earlier"

export interface RecencyBucket {
  key: RecencyBucketKey
  items: NotificationRecord[]
}

/** Start of the local calendar day containing `at` (ms epoch). */
export function startOfLocalDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Group `records` (assumed newest-first) into Today / Yesterday / Earlier.
 * Empty buckets are dropped, and the relative order within each bucket is
 * preserved, so the caller can render them top-to-bottom directly.
 */
export function bucketByRecency(records: NotificationRecord[], now: number): RecencyBucket[] {
  const startToday = startOfLocalDay(now)
  const startYesterday = startToday - 24 * 60 * 60 * 1000

  const today: NotificationRecord[] = []
  const yesterday: NotificationRecord[] = []
  const earlier: NotificationRecord[] = []

  for (const r of records) {
    if (r.createdAt >= startToday) today.push(r)
    else if (r.createdAt >= startYesterday) yesterday.push(r)
    else earlier.push(r)
  }

  const ordered: RecencyBucket[] = [
    { key: "today", items: today },
    { key: "yesterday", items: yesterday },
    { key: "earlier", items: earlier },
  ]
  return ordered.filter((b) => b.items.length > 0)
}

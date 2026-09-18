// Notification V2 digest/aggregation policy (pure + DB glue).
//
// A digest folds several low-priority facts into one periodic send instead
// of N interrupts. The policy answers three questions:
//   • Should this fact fold into a bucket now, or send on its own?
//   • Which bucket does it join (aggregateKey + bucketOpenedAt boundary)?
//   • When does the bucket close and flush?
//
// Crash recovery is by construction: every fold writes an
// `notificationAggregateMembers` row FIRST, so a restarted projector can
// enumerate exactly what joined before the crash — no double-count, no loss.
// A fact arriving after a bucket's `bucketOpenedAt` boundary joins the NEXT
// bucket (or an explicit supplement), never a sealed one.

import type { NotificationAggregateMember } from "@/types/notifications/delivery"
import type { PlannerFact } from "./planner"
import {
  addAggregateMember,
  listUnflushedMembers,
  markMembersFlushed,
} from "@/lib/db/notification-aggregates"
import { armNotificationTimer } from "@/lib/db/notification-timers"

/** Digest window — how long a bucket stays open before flushing. */
export interface DigestWindow {
  /** Ms a bucket stays open collecting members. */
  windowMs: number
  /** Max members before an early flush. */
  maxMembers?: number
}

export const DEFAULT_DIGEST_WINDOW: DigestWindow = {
  windowMs: 15 * 60 * 1000,
  maxMembers: 25,
}

/**
 * Render a fact's aggregate key from a template. `{scope}` `{category}`
 * `{taskId}` `{day}` `{hour}` placeholders; a missing template yields a
//   per-day-per-category default bucket.
 */
export function aggregateKeyFor(
  template: string | undefined,
  fact: PlannerFact,
  scopeKey: string,
  now: number
): string {
  const d = new Date(now)
  const day = d.toISOString().slice(0, 10)
  const hour = String(d.getUTCHours()).padStart(2, "0")
  return (template ?? "{scope}:{category}:{day}")
    .replace("{scope}", scopeKey)
    .replace("{category}", fact.category)
    .replace("{taskId}", fact.runId ?? "none")
    .replace("{day}", day)
    .replace("{hour}", hour)
}

/**
 * Fold a fact into its digest bucket — writes the member row (idempotent)
 * and arms the bucket's flush timer on first member. Returns the member row
 * + the flush deadline the bucket will close at.
 */
export async function foldIntoDigest(input: {
  fact: PlannerFact & { notificationId: string }
  scopeKey: string
  aggregateKey: string
  window?: DigestWindow
  now?: number
}): Promise<{ member: NotificationAggregateMember; flushAt: number }> {
  const now = input.now ?? Date.now()
  const window = input.window ?? DEFAULT_DIGEST_WINDOW
  // The bucket boundary is the window START that contains `now`, floored —
  // so every member in the same window shares one bucketOpenedAt, and a fact
  // landing after close lands in the next window's bucket.
  const bucketOpenedAt = Math.floor(now / window.windowMs) * window.windowMs
  const flushAt = bucketOpenedAt + window.windowMs
  const member = await addAggregateMember({
    scopeKey: input.scopeKey,
    aggregateKey: input.aggregateKey,
    notificationId: input.fact.notificationId,
    ...(input.fact.factKey ? { logicalKey: input.fact.factKey } : {}),
    joinedAt: now,
    bucketOpenedAt,
  })
  // Arm the flush timer only once — the member row's idempotency means a
  // concurrent fold doesn't mint a second timer for the same bucket.
  await armNotificationTimer({
    scopeKey: input.scopeKey,
    kind: "digest-flush",
    aggregateKey: input.aggregateKey,
    dueAt: flushAt,
  }).catch(() => undefined)
  return { member, flushAt }
}

/**
 * Flush a closed bucket — reads unflushed members, returns them for the
 * digest render, and (post-accept) marks them flushed. The caller renders
 * the digest from the returned members and calls `markMembersFlushed`
 * inside the send-commit transaction so a crash between render and commit
 * re-reads the same unflushed set on recovery.
 */
export async function flushDigestBucket(input: {
  aggregateKey: string
  bucketOpenedAt: number
}): Promise<NotificationAggregateMember[]> {
  return listUnflushedMembers(input.aggregateKey, input.bucketOpenedAt)
}

/** Mark members flushed — after the digest send is accepted. */
export async function completeDigestFlush(memberIds: string[], flushedAt: number): Promise<void> {
  return markMembersFlushed(memberIds, flushedAt)
}

/** Should a bucket flush early on membership count? */
export function shouldFlushEarly(memberCount: number, window: DigestWindow): boolean {
  return window.maxMembers !== undefined && memberCount >= window.maxMembers
}

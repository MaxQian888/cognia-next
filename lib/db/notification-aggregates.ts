// Dexie access for Notification V2 digest/aggregate members (v227).
//
// Each row is one fact folded into a digest bucket — the durable crash-
// recovery evidence that lets a restarted projector flush exactly the members
// that joined before the crash, with no double-count. `aggregateKey` names
// the bucket (`{scopeKey}:{template-rendered}`); `bucketOpenedAt` bounds the
// window so a late event after close joins the NEXT bucket, never a sealed
// one.

import { nanoid } from "nanoid"
import { getDb, type CogniaDB } from "./schema"
import type { NotificationAggregateMember } from "@/types/notifications/delivery"

export type { NotificationAggregateMember }

/** Fold a fact into a bucket — one member row per (aggregateKey, notificationId). */
export async function addAggregateMember(
  input: Omit<NotificationAggregateMember, "id" | "createdAt" | "joinedAt"> & { joinedAt?: number },
  txDb?: CogniaDB
): Promise<NotificationAggregateMember> {
  const db = txDb ?? getDb()
  const now = Date.now()
  const run = async (): Promise<NotificationAggregateMember> => {
    // Idempotent join — re-adding the same fact to the same open bucket is a
    // no-op (crash recovery replays the fold without double-counting).
    const existing = await db.notificationAggregateMembers
      .where("aggregateKey")
      .equals(input.aggregateKey)
      .filter(
        (m) =>
          m.notificationId === input.notificationId && m.bucketOpenedAt === input.bucketOpenedAt
      )
      .first()
    if (existing) return existing
    const row: NotificationAggregateMember = {
      ...input,
      id: nanoid(),
      joinedAt: input.joinedAt ?? now,
      createdAt: now,
    }
    await db.notificationAggregateMembers.put(row)
    return row
  }
  if (txDb) return run()
  return db.transaction("rw", db.notificationAggregateMembers, run)
}

/** Unflushed members of one bucket — the digest-flush read. */
export async function listUnflushedMembers(
  aggregateKey: string,
  bucketOpenedAt?: number
): Promise<NotificationAggregateMember[]> {
  return getDb()
    .notificationAggregateMembers.where("aggregateKey")
    .equals(aggregateKey)
    .filter(
      (m) =>
        m.flushedAt === undefined &&
        (bucketOpenedAt === undefined || m.bucketOpenedAt === bucketOpenedAt)
    )
    .toArray()
}

/** Mark a set of members flushed — after the digest send is accepted. */
export async function markMembersFlushed(
  memberIds: string[],
  flushedAt: number,
  txDb?: CogniaDB
): Promise<void> {
  const db = txDb ?? getDb()
  const run = async (): Promise<void> => {
    for (const id of memberIds) {
      const row = await db.notificationAggregateMembers.get(id)
      if (!row || row.flushedAt !== undefined) continue
      await db.notificationAggregateMembers.put({ ...row, flushedAt })
    }
  }
  if (txDb) return run()
  return db.transaction("rw", db.notificationAggregateMembers, run)
}

/** Members of a fact across buckets — "where did this fact get digested". */
export async function listMembersForNotification(
  notificationId: string
): Promise<NotificationAggregateMember[]> {
  return getDb()
    .notificationAggregateMembers.where("notificationId")
    .equals(notificationId)
    .toArray()
}

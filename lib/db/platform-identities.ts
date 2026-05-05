/**
 * CRUD layer for the `platformIdentities` Dexie table (schema v18).
 *
 * One row per observed platform user. Keyed by a generated id with a unique
 * compound index on [platform+remoteUserId] for cross-platform identity merge.
 */

import type { PlatformIdentityRow } from "./connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { getDb } from "./schema"

function newId(): string {
  return "pid_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface UpsertIdentityInput {
  platform: PlatformKind
  adapterId: string
  remoteUserId: string
  displayName?: string
  avatarUrl?: string
}

/**
 * Create or update a platform identity row. Keyed by [platform+remoteUserId].
 * Bumps `lastSeenAt` on every call. Returns the current row.
 */
export async function upsertIdentity(input: UpsertIdentityInput): Promise<PlatformIdentityRow> {
  const db = getDb()
  const now = Date.now()
  const existing = await db.platformIdentities
    .where("[platform+remoteUserId]")
    .equals([input.platform, input.remoteUserId])
    .first()

  if (existing) {
    const updated: PlatformIdentityRow = {
      ...existing,
      adapterId: input.adapterId,
      displayName: input.displayName ?? existing.displayName,
      avatarUrl: input.avatarUrl ?? existing.avatarUrl,
      lastSeenAt: now,
    }
    await db.platformIdentities.put(updated)
    return updated
  }

  const row: PlatformIdentityRow = {
    id: newId(),
    platform: input.platform,
    adapterId: input.adapterId,
    remoteUserId: input.remoteUserId,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    mergedFromIds: [],
    lastSeenAt: now,
  }
  await db.platformIdentities.add(row)
  return row
}

/**
 * Merge secondary identity into primary. Appends secondaryId to
 * `primary.mergedFromIds` and deletes the secondary row.
 */
export async function mergeIdentities(
  primaryId: string,
  secondaryId: string
): Promise<PlatformIdentityRow> {
  const db = getDb()
  return db.transaction("rw", db.platformIdentities, async () => {
    const primary = await db.platformIdentities.get(primaryId)
    if (!primary) throw new Error(`platform-identities: primary id "${primaryId}" not found`)
    const merged: PlatformIdentityRow = {
      ...primary,
      mergedFromIds: [...(primary.mergedFromIds ?? []), secondaryId],
    }
    await db.platformIdentities.put(merged)
    await db.platformIdentities.delete(secondaryId)
    return merged
  })
}

/** List all identities for one adapter, ordered by lastSeenAt descending. */
export async function listByAdapter(adapterId: string): Promise<PlatformIdentityRow[]> {
  const rows = await getDb()
    .platformIdentities.where("[adapterId+remoteUserId]")
    .between([adapterId, Dexie.minKey], [adapterId, Dexie.maxKey])
    .toArray()
  return rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

/** Look up a single identity by platform + remoteUserId. */
export async function getByPlatformUser(
  platform: PlatformKind,
  remoteUserId: string
): Promise<PlatformIdentityRow | undefined> {
  return getDb()
    .platformIdentities.where("[platform+remoteUserId]")
    .equals([platform, remoteUserId])
    .first()
}

// Bring Dexie into scope for minKey/maxKey usage in listByAdapter.
import Dexie from "dexie"

// Dexie access for Notification V2 publications (v227).
//
// A publication is the serialized external-message slot: ONE platform
// message/card a notification owns, addressed by `slotKey`
// (`runId:purpose:addressFingerprint`). Every update to that same platform
// message is a new intent on the SAME publication row — `renderedRevision`
// CAS-guards the overwrite so two projectors can't interleave content, and
// the platformMessageId + acceptedContentHash track what the platform
// actually acknowledged.

import { nanoid } from "nanoid"
import { getDb, type CogniaDB } from "./schema"
import type { NotificationPublication } from "@/types/notifications/delivery"

export type { NotificationPublication }

/**
 * Get-or-create the publication for a slot. The unique `&slotKey` index makes
 * two creators for the same slot a constraint violation — but to keep this
 * race-free inside a caller's transaction we read-then-write within it and
 * return the existing row if it appeared concurrently.
 */
export async function getOrCreatePublication(
  input: Omit<NotificationPublication, "id" | "renderedRevision" | "createdAt" | "updatedAt">,
  txDb?: CogniaDB
): Promise<NotificationPublication> {
  const db = txDb ?? getDb()
  const now = Date.now()
  const run = async (): Promise<NotificationPublication> => {
    const existing = await db.notificationPublications
      .where("slotKey")
      .equals(input.slotKey)
      .first()
    if (existing) return existing
    const row: NotificationPublication = {
      ...input,
      id: nanoid(),
      renderedRevision: 0,
      createdAt: now,
      updatedAt: now,
    }
    await db.notificationPublications.put(row)
    return row
  }
  if (txDb) return run()
  return db.transaction("rw", db.notificationPublications, run)
}

/**
 * CAS-advance a publication after a send is accepted. `expectedRevision` is
 * the revision the just-sent intent was rendered against; only a matching
 * row is advanced, so a stale writer can't overwrite a newer accepted render.
 * Returns the updated row, or `undefined` on a CAS failure.
 */
export async function commitPublicationRender(
  publicationId: string,
  expectedRevision: number,
  update: {
    platformMessageId?: string
    acceptedContentHash?: string
    runTerminal?: boolean
    state?: NotificationPublication["state"]
  },
  txDb?: CogniaDB
): Promise<NotificationPublication | undefined> {
  const db = txDb ?? getDb()
  const now = Date.now()
  const run = async (): Promise<NotificationPublication | undefined> => {
    const row = await db.notificationPublications.get(publicationId)
    if (!row || row.renderedRevision !== expectedRevision) return undefined
    const next: NotificationPublication = {
      ...row,
      renderedRevision: row.renderedRevision + 1,
      ...(update.platformMessageId !== undefined
        ? { platformMessageId: update.platformMessageId }
        : {}),
      ...(update.acceptedContentHash !== undefined
        ? { acceptedContentHash: update.acceptedContentHash }
        : {}),
      ...(update.runTerminal !== undefined ? { runTerminal: update.runTerminal } : {}),
      ...(update.state !== undefined ? { state: update.state } : {}),
      updatedAt: now,
    }
    await db.notificationPublications.put(next)
    return next
  }
  if (txDb) return run()
  return db.transaction("rw", db.notificationPublications, run)
}

export async function getPublication(id: string): Promise<NotificationPublication | undefined> {
  return getDb().notificationPublications.get(id)
}

export async function getPublicationBySlot(
  slotKey: string
): Promise<NotificationPublication | undefined> {
  return getDb().notificationPublications.where("slotKey").equals(slotKey).first()
}

/** Open publications for a fact — the "what's live for this notification" set. */
export async function listPublicationsForNotification(
  notificationId: string
): Promise<NotificationPublication[]> {
  return getDb()
    .notificationPublications.where("notificationId")
    .equals(notificationId)
    .filter((p) => p.state === "open")
    .toArray()
}

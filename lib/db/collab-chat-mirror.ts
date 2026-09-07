import { getDb } from "./schema"

/** Opaque local key: remote identifiers are never used as global Dexie keys. */
export function sharedChatCacheKey(orgId: string, sessionId: string, endpoint?: string): string {
  return endpoint ? JSON.stringify([endpoint.replace(/\/+$/, ""), orgId, sessionId]) : sessionId
}
import type {
  CollabChatApprovalMirrorRow,
  CollabChatAttachmentMirrorRow,
  CollabChatEventMirrorRow,
  CollabChatInviteMirrorRow,
  CollabChatMembershipMirrorRow,
  CollabChatSessionMirrorRow,
  CollabChatSyncStateRow,
} from "./collab-chat-mirror-types"

export async function replaceCollabChatSessions(
  orgId: string,
  workspaceId: string,
  rows: readonly CollabChatSessionMirrorRow[]
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.collabChatSessions, async () => {
    const stale = await db.collabChatSessions
      .where("[orgId+workspaceId]")
      .equals([orgId, workspaceId])
      .primaryKeys()
    if (stale.length) await db.collabChatSessions.bulkDelete(stale)
    if (rows.length) await db.collabChatSessions.bulkPut([...rows])
  })
}

export async function listCollabChatSessions(
  orgId: string,
  workspaceId: string
): Promise<CollabChatSessionMirrorRow[]> {
  return getDb()
    .collabChatSessions.where("[orgId+workspaceId]")
    .equals([orgId, workspaceId])
    .toArray()
}

export async function replaceCollabChatMembers(
  orgId: string,
  sessionId: string,
  rows: readonly CollabChatMembershipMirrorRow[]
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.collabChatMemberships, async () => {
    const stale = await db.collabChatMemberships.where("sessionId").equals(sessionId).primaryKeys()
    if (stale.length) await db.collabChatMemberships.bulkDelete(stale)
    if (rows.length) await db.collabChatMemberships.bulkPut(rows.map((row) => ({ ...row, orgId })))
  })
}

export async function appendCollabChatEvents(
  rows: readonly CollabChatEventMirrorRow[]
): Promise<void> {
  if (!rows.length) return
  const db = getDb()
  // Receipt is not application. Only the transaction that updates the message
  // projection may advance the durable sync cursor.
  await db.collabChatEvents.bulkPut([...rows])
}

export async function listCollabChatEvents(sessionId: string): Promise<CollabChatEventMirrorRow[]> {
  return getDb().collabChatEvents.where("sessionId").equals(sessionId).sortBy("sequence")
}

export async function purgeCollabChatSession(sessionId: string): Promise<void> {
  const db = getDb()
  await db.transaction(
    "rw",
    [
      db.collabChatSessions,
      db.collabChatMemberships,
      db.collabChatEvents,
      db.collabChatInvites,
      db.collabChatApprovals,
      db.collabChatSyncStates,
      db.collabChatAttachments,
    ],
    async () => {
      await Promise.all([
        db.collabChatSessions.delete(sessionId),
        db.collabChatMemberships.where("sessionId").equals(sessionId).delete(),
        db.collabChatEvents.where("sessionId").equals(sessionId).delete(),
        db.collabChatInvites.where("sessionId").equals(sessionId).delete(),
        db.collabChatApprovals.where("sessionId").equals(sessionId).delete(),
        db.collabChatSyncStates.delete(sessionId),
        db.collabChatAttachments.where("sessionId").equals(sessionId).delete(),
      ])
    }
  )
}

export async function putCollabChatSyncState(row: CollabChatSyncStateRow): Promise<void> {
  await getDb().collabChatSyncStates.put(row)
}

export async function putCollabChatAttachment(row: CollabChatAttachmentMirrorRow): Promise<void> {
  await getDb().collabChatAttachments.put(row)
}

export async function removeCollabChatAttachment(attachmentId: string): Promise<void> {
  await getDb().collabChatAttachments.delete(attachmentId)
}

export type {
  CollabChatApprovalMirrorRow,
  CollabChatAttachmentMirrorRow,
  CollabChatInviteMirrorRow,
  CollabChatSyncStateRow,
}

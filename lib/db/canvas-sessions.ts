/**
 * Dexie CRUD for `canvasSessions` (schema v11+).
 *
 * Stores collaboration *session metadata* — owner, participants, permissions,
 * isActive flag — so the UI can list recent sessions across app restarts and
 * the CRDT layer can rehydrate them. Document content lives in
 * `canvasDocuments` / artifact-store; per-CRDT-op streams are intentionally
 * NOT persisted here.
 *
 * Indexes: `id, documentId, ownerId, createdAt`. `participants` is JSON-
 * serialised at the boundary because IndexedDB cannot index a Date inside a
 * nested object.
 */

import type { CollaborativeSession, Participant } from "@/types/canvas/collaboration"
import type { CanvasSessionRow } from "./canvas-types"
import { getDb } from "./schema"

function serializeParticipants(participants: Participant[]): string {
  return JSON.stringify(
    participants.map((p) => ({
      ...p,
      lastActive: p.lastActive instanceof Date ? p.lastActive.toISOString() : p.lastActive,
    }))
  )
}

function deserializeParticipants(json: string | undefined): Participant[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as Array<Participant & { lastActive: string | Date }>
    return parsed.map((p) => ({
      ...p,
      lastActive: typeof p.lastActive === "string" ? new Date(p.lastActive) : p.lastActive,
    }))
  } catch {
    return []
  }
}

function toRow(session: CollaborativeSession): CanvasSessionRow {
  return {
    id: session.id,
    documentId: session.documentId,
    ownerId: session.ownerId,
    createdAt: session.createdAt.getTime(),
    updatedAt: session.updatedAt.getTime(),
    isActive: session.isActive,
    shareLink: session.shareLink,
    permissions: session.permissions,
    participants: serializeParticipants(session.participants),
  }
}

function fromRow(row: CanvasSessionRow): CollaborativeSession {
  return {
    id: row.id,
    documentId: row.documentId,
    ownerId: row.ownerId,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    isActive: row.isActive,
    shareLink: row.shareLink,
    permissions: row.permissions,
    participants: deserializeParticipants(row.participants),
  }
}

/**
 * Insert or replace a session row. Idempotent — safe to call from CRDT
 * lifecycle hooks (createSession / joinSession) which fire repeatedly with
 * the same id.
 */
export async function upsertSession(session: CollaborativeSession): Promise<void> {
  const db = getDb()
  await db.canvasSessions.put(toRow(session))
}

export async function getSession(id: string): Promise<CollaborativeSession | undefined> {
  const db = getDb()
  const row = await db.canvasSessions.get(id)
  return row ? fromRow(row) : undefined
}

/**
 * Most-recent active session for a document, if any. Falls back to scanning
 * the documentId index then filtering — IndexedDB does not reliably index
 * boolean fields so we filter in memory.
 */
export async function getActiveSessionForDocument(
  documentId: string
): Promise<CollaborativeSession | undefined> {
  const db = getDb()
  const rows = await db.canvasSessions.where("documentId").equals(documentId).toArray()
  const active = rows.filter((r) => r.isActive)
  if (active.length === 0) return undefined
  active.sort((a, b) => b.createdAt - a.createdAt)
  return fromRow(active[0])
}

/** Soft-close: flip `isActive` to false but keep the row (audit trail). */
export async function closeSession(id: string): Promise<void> {
  const db = getDb()
  await db.canvasSessions.update(id, {
    isActive: false,
    updatedAt: Date.now(),
  })
}

/** N most-recent sessions, newest-first. */
export async function listRecent(limit = 20): Promise<CollaborativeSession[]> {
  const db = getDb()
  let coll = db.canvasSessions.orderBy("createdAt").reverse()
  if (limit > 0) coll = coll.limit(limit)
  const rows = await coll.toArray()
  return rows.map(fromRow)
}

export async function deleteSession(id: string): Promise<void> {
  const db = getDb()
  await db.canvasSessions.delete(id)
}

/**
 * Bulk import — used by the snapshot/backup layer. Skips rows that already
 * exist (matched by id).
 */
export async function bulkImport(sessions: CollaborativeSession[]): Promise<number> {
  if (sessions.length === 0) return 0
  const db = getDb()
  let inserted = 0
  await db.transaction("rw", db.canvasSessions, async () => {
    for (const s of sessions) {
      const existing = await db.canvasSessions.get(s.id)
      if (existing) continue
      await db.canvasSessions.add(toRow(s))
      inserted += 1
    }
  })
  return inserted
}

/** All sessions, used by snapshot export. */
export async function listAll(): Promise<CollaborativeSession[]> {
  const db = getDb()
  const rows = await db.canvasSessions.toArray()
  return rows.map(fromRow)
}

export const __TESTING__ = {
  toRow,
  fromRow,
  serializeParticipants,
  deserializeParticipants,
}

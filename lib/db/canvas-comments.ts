/**
 * Dexie CRUD for `canvasComments` (schema v11+).
 *
 * Comments are line-anchored on a document. Replies use `parentId`.
 * Indexes: `id, documentId, [documentId+createdAt], parentId, resolvedAt`.
 *
 * Boundary contract:
 *  - Public functions accept/return runtime `CanvasComment` (Date timestamps).
 *  - Internal rows use `CanvasCommentRow` (number timestamps) so IndexedDB can
 *    index them. Conversion happens in `toRow` / `fromRow`.
 */

import { nanoid } from "nanoid"
import type { CanvasComment, CommentReaction, LineRange } from "@/types/canvas/collaboration"
import type { CanvasCommentRow } from "./canvas-types"
import { getDb } from "./schema"

export type AddCommentInput = Omit<CanvasComment, "id" | "createdAt" | "updatedAt" | "reactions">

export type ReplyInput = Omit<
  CanvasComment,
  "id" | "createdAt" | "updatedAt" | "reactions" | "range" | "parentId" | "documentId"
>

function toRow(comment: CanvasComment): CanvasCommentRow {
  return {
    ...comment,
    createdAt: comment.createdAt.getTime(),
    updatedAt: comment.updatedAt?.getTime(),
    resolvedAt: comment.resolvedAt?.getTime(),
  }
}

function fromRow(row: CanvasCommentRow): CanvasComment {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: row.updatedAt !== undefined ? new Date(row.updatedAt) : undefined,
    resolvedAt: row.resolvedAt !== undefined ? new Date(row.resolvedAt) : undefined,
  }
}

/** All comments on a document, oldest-first (matches the [documentId+createdAt] index). */
export async function listForDocument(documentId: string): Promise<CanvasComment[]> {
  const db = getDb()
  const rows = await db.canvasComments.where("documentId").equals(documentId).sortBy("createdAt")
  return rows.map(fromRow)
}

/** All comments anchored to lines that overlap `range`. */
export async function listInRange(documentId: string, range: LineRange): Promise<CanvasComment[]> {
  const all = await listForDocument(documentId)
  return all.filter(
    (c) => c.range && c.range.startLine <= range.endLine && c.range.endLine >= range.startLine
  )
}

/** Top-level comments (no parentId) that have not been resolved. */
export async function listUnresolved(documentId: string): Promise<CanvasComment[]> {
  const all = await listForDocument(documentId)
  return all.filter((c) => !c.resolvedAt && !c.parentId)
}

export async function addComment(input: AddCommentInput): Promise<CanvasComment> {
  const comment: CanvasComment = {
    ...input,
    id: nanoid(),
    createdAt: new Date(),
    reactions: [],
  }
  const db = getDb()
  await db.canvasComments.add(toRow(comment))
  return comment
}

export async function updateComment(commentId: string, content: string): Promise<void> {
  const db = getDb()
  await db.canvasComments.update(commentId, {
    content,
    updatedAt: Date.now(),
  })
}

/** Delete a comment and any replies anchored to it. */
export async function deleteComment(commentId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.canvasComments, async () => {
    const replies = await db.canvasComments.where("parentId").equals(commentId).primaryKeys()
    await db.canvasComments.bulkDelete([commentId, ...(replies as string[])])
  })
}

export async function resolveComment(commentId: string, resolvedBy?: string): Promise<void> {
  const db = getDb()
  await db.canvasComments.update(commentId, {
    resolvedAt: Date.now(),
    resolvedBy,
  })
}

export async function unresolveComment(commentId: string): Promise<void> {
  const db = getDb()
  await db.canvasComments.update(commentId, {
    resolvedAt: undefined,
    resolvedBy: undefined,
  })
}

export async function addReaction(commentId: string, emoji: string, userId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.canvasComments, async () => {
    const row = await db.canvasComments.get(commentId)
    if (!row) return
    const reactions = nextReactionsAfterAdd(row.reactions ?? [], emoji, userId)
    await db.canvasComments.update(commentId, { reactions })
  })
}

export async function removeReaction(
  commentId: string,
  emoji: string,
  userId: string
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.canvasComments, async () => {
    const row = await db.canvasComments.get(commentId)
    if (!row) return
    const reactions = nextReactionsAfterRemove(row.reactions ?? [], emoji, userId)
    await db.canvasComments.update(commentId, { reactions })
  })
}

export async function replyToComment(parentId: string, reply: ReplyInput): Promise<CanvasComment> {
  const db = getDb()
  const parent = await db.canvasComments.get(parentId)
  if (!parent) {
    throw new Error(`Parent comment ${parentId} not found`)
  }
  const comment: CanvasComment = {
    ...reply,
    id: nanoid(),
    documentId: parent.documentId,
    range: parent.range,
    parentId,
    createdAt: new Date(),
    reactions: [],
  }
  await db.canvasComments.add(toRow(comment))
  return comment
}

/** Cascade-delete all comments for a document. */
export async function clearForDocument(documentId: string): Promise<void> {
  const db = getDb()
  await db.canvasComments.where("documentId").equals(documentId).delete()
}

/**
 * Bulk import — used by the localStorage → Dexie migration in `comment-store`
 * and by the backup snapshot module. Skips rows that already exist.
 */
export async function bulkImport(comments: CanvasComment[]): Promise<number> {
  if (comments.length === 0) return 0
  const db = getDb()
  let inserted = 0
  await db.transaction("rw", db.canvasComments, async () => {
    for (const c of comments) {
      const existing = await db.canvasComments.get(c.id)
      if (existing) continue
      await db.canvasComments.add(toRow(c))
      inserted += 1
    }
  })
  return inserted
}

/** Read-side helper for the snapshot/backup layer. */
export async function listAll(): Promise<CanvasComment[]> {
  const db = getDb()
  const rows = await db.canvasComments.toArray()
  return rows.map(fromRow)
}

function nextReactionsAfterAdd(
  reactions: CommentReaction[],
  emoji: string,
  userId: string
): CommentReaction[] {
  const next = reactions.map((r) => ({ ...r, users: [...r.users] }))
  const existing = next.find((r) => r.emoji === emoji)
  if (existing) {
    if (!existing.users.includes(userId)) existing.users.push(userId)
    return next
  }
  next.push({ emoji, users: [userId] })
  return next
}

function nextReactionsAfterRemove(
  reactions: CommentReaction[],
  emoji: string,
  userId: string
): CommentReaction[] {
  return reactions
    .map((r) => (r.emoji === emoji ? { ...r, users: r.users.filter((u) => u !== userId) } : r))
    .filter((r) => r.users.length > 0)
}

export const __TESTING__ = { toRow, fromRow, nextReactionsAfterAdd, nextReactionsAfterRemove }

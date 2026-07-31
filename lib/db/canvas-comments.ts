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

import type { CanvasComment, CommentReaction, LineRange } from "@/types/canvas/collaboration"
import type { CanvasCommentRow } from "./canvas-types"
import {
  addContextComment,
  addContextCommentReaction,
  bulkImportContextComments,
  canvasCommentFromContext,
  canvasCommentRowFromContext,
  clearContextCommentsForResource,
  contextCommentRowFromCanvas,
  deleteContextComment,
  listAllContextCommentRows,
  listContextCommentRowsForResource,
  removeContextCommentReaction,
  reopenContextComment,
  replyToContextComment,
  resolveContextComment,
  updateContextComment,
} from "./context-comments"

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
  const rows = await listContextCommentRowsForResource("canvas-document", documentId)
  return rows.map((row) => fromRow(canvasCommentRowFromContext(row)))
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
  return canvasCommentFromContext(
    await addContextComment({
      resource: { kind: "canvas-document", id: input.documentId },
      anchor: { kind: "text-range", start: 0, end: 0, lineRange: input.range },
      authorId: input.authorId,
      authorName: input.authorName,
      authorAvatarUrl: input.authorAvatarUrl,
      content: input.content,
    })
  )
}

export async function updateComment(commentId: string, content: string): Promise<void> {
  await updateContextComment(commentId, content)
}

/** Delete a comment and any replies anchored to it. */
export async function deleteComment(commentId: string): Promise<void> {
  await deleteContextComment(commentId)
}

export async function resolveComment(commentId: string, resolvedBy?: string): Promise<void> {
  await resolveContextComment(commentId, resolvedBy)
}

export async function unresolveComment(commentId: string): Promise<void> {
  await reopenContextComment(commentId)
}

export async function addReaction(commentId: string, emoji: string, userId: string): Promise<void> {
  await addContextCommentReaction(commentId, emoji, userId)
}

export async function removeReaction(
  commentId: string,
  emoji: string,
  userId: string
): Promise<void> {
  await removeContextCommentReaction(commentId, emoji, userId)
}

export async function replyToComment(parentId: string, reply: ReplyInput): Promise<CanvasComment> {
  return canvasCommentFromContext(
    await replyToContextComment(parentId, {
      authorId: reply.authorId,
      authorName: reply.authorName,
      authorAvatarUrl: reply.authorAvatarUrl,
      content: reply.content,
    })
  )
}

/** Cascade-delete all comments for a document. */
export async function clearForDocument(documentId: string): Promise<void> {
  await clearContextCommentsForResource("canvas-document", documentId)
}

/**
 * Bulk import — used by the localStorage → Dexie migration in `comment-store`
 * and by the backup snapshot module. Skips rows that already exist.
 */
export async function bulkImport(comments: CanvasComment[]): Promise<number> {
  if (comments.length === 0) return 0
  return bulkImportContextComments(
    comments.map((comment) => contextCommentRowFromCanvas(toRow(comment)))
  )
}

/** Read-side helper for the snapshot/backup layer. */
export async function listAll(): Promise<CanvasComment[]> {
  const rows = (await listAllContextCommentRows()).filter(
    (row) => row.resourceKind === "canvas-document"
  )
  return rows.map((row) => fromRow(canvasCommentRowFromContext(row)))
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

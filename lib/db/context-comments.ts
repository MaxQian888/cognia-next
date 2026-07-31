import { nanoid } from "nanoid"
import type { CanvasComment } from "@/types/canvas/collaboration"
import type {
  ContextComment,
  ContextCommentAnchor,
  ContextCommentResourceKind,
  ContextCommentResourceRef,
  ContextCommentRow,
} from "@/types/context-comment"
import type { CanvasCommentRow } from "./canvas-types"
import { contextCommentRowFromCanvas } from "./context-comments-backfill"
import { getDb } from "./schema"

export { contextCommentRowFromCanvas } from "./context-comments-backfill"

export interface AddContextCommentInput {
  resource: ContextCommentResourceRef
  anchor: ContextCommentAnchor
  authorId: string
  authorName: string
  authorAvatarUrl?: string
  content: string
}

export interface ReplyToContextCommentInput {
  authorId: string
  authorName: string
  authorAvatarUrl?: string
  content: string
}

function toRow(comment: ContextComment): ContextCommentRow {
  return {
    ...comment,
    createdAt: comment.createdAt.getTime(),
    updatedAt: comment.updatedAt?.getTime(),
    resolvedAt: comment.resolvedAt?.getTime(),
  }
}

function fromRow(row: ContextCommentRow): ContextComment {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: row.updatedAt === undefined ? undefined : new Date(row.updatedAt),
    resolvedAt: row.resolvedAt === undefined ? undefined : new Date(row.resolvedAt),
  }
}

export function canvasCommentRowFromContext(row: ContextCommentRow): CanvasCommentRow {
  if (row.resourceKind !== "canvas-document") {
    throw new Error(`Cannot convert ${row.resourceKind} comment to a Canvas comment`)
  }
  return {
    id: row.id,
    documentId: row.resourceId,
    projectId: row.projectId,
    authorId: row.authorId,
    authorName: row.authorName,
    authorAvatarUrl: row.authorAvatarUrl,
    content: row.content,
    range:
      row.anchor.kind === "text-range" && row.anchor.lineRange
        ? row.anchor.lineRange
        : { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    reactions: row.reactions ?? [],
    parentId: row.parentId,
  }
}

export function contextCommentFromCanvas(comment: CanvasComment): ContextComment {
  return fromRow(
    contextCommentRowFromCanvas({
      ...comment,
      createdAt: comment.createdAt.getTime(),
      updatedAt: comment.updatedAt?.getTime(),
      resolvedAt: comment.resolvedAt?.getTime(),
    })
  )
}

export function canvasCommentFromContext(comment: ContextComment): CanvasComment {
  const row = canvasCommentRowFromContext(toRow(comment))
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: row.updatedAt === undefined ? undefined : new Date(row.updatedAt),
    resolvedAt: row.resolvedAt === undefined ? undefined : new Date(row.resolvedAt),
  }
}

export async function listContextCommentRowsForResource(
  resourceKind: ContextCommentResourceKind,
  resourceId: string
): Promise<ContextCommentRow[]> {
  const rows = await getDb()
    .contextComments.where("[resourceKind+resourceId]")
    .equals([resourceKind, resourceId])
    .sortBy("createdAt")
  return rows.sort((left, right) => {
    const byCreatedAt = left.createdAt - right.createdAt
    if (byCreatedAt !== 0) return byCreatedAt
    if (Boolean(left.parentId) !== Boolean(right.parentId)) return left.parentId ? 1 : -1
    return left.id.localeCompare(right.id)
  })
}

export async function listContextCommentsForResource(
  resourceKind: ContextCommentResourceKind,
  resourceId: string
): Promise<ContextComment[]> {
  return (await listContextCommentRowsForResource(resourceKind, resourceId)).map(fromRow)
}

export async function listUnresolvedContextComments(
  resourceKind: ContextCommentResourceKind,
  resourceId: string
): Promise<ContextComment[]> {
  return (await listContextCommentsForResource(resourceKind, resourceId)).filter(
    (comment) => !comment.parentId && comment.resolvedAt === undefined
  )
}

export async function addContextComment(input: AddContextCommentInput): Promise<ContextComment> {
  const comment: ContextComment = {
    id: nanoid(),
    resourceKind: input.resource.kind,
    resourceId: input.resource.id,
    projectId: input.resource.projectId,
    anchor: input.anchor,
    authorId: input.authorId,
    authorName: input.authorName,
    authorAvatarUrl: input.authorAvatarUrl,
    content: input.content,
    createdAt: new Date(),
    reactions: [],
  }
  await getDb().contextComments.add(toRow(comment))
  return comment
}

export async function updateContextComment(commentId: string, content: string): Promise<void> {
  await getDb().contextComments.update(commentId, { content, updatedAt: Date.now() })
}

export async function deleteContextComment(commentId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.contextComments, async () => {
    const pending = [commentId]
    const ids = new Set<string>()
    while (pending.length > 0) {
      const parentId = pending.shift()!
      if (ids.has(parentId)) continue
      ids.add(parentId)
      const replies = (await db.contextComments
        .where("parentId")
        .equals(parentId)
        .primaryKeys()) as string[]
      pending.push(...replies)
    }
    await db.contextComments.bulkDelete([...ids])
  })
}

export async function resolveContextComment(commentId: string, resolvedBy?: string): Promise<void> {
  await getDb().contextComments.update(commentId, { resolvedAt: Date.now(), resolvedBy })
}

export async function reopenContextComment(commentId: string): Promise<void> {
  await getDb().contextComments.update(commentId, {
    resolvedAt: undefined,
    resolvedBy: undefined,
  })
}

export async function addContextCommentReaction(
  commentId: string,
  emoji: string,
  userId: string
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.contextComments, async () => {
    const row = await db.contextComments.get(commentId)
    if (!row) return
    const reactions = row.reactions.map((reaction) => ({
      ...reaction,
      users: [...reaction.users],
    }))
    const existing = reactions.find((reaction) => reaction.emoji === emoji)
    if (existing) {
      if (!existing.users.includes(userId)) existing.users.push(userId)
    } else {
      reactions.push({ emoji, users: [userId] })
    }
    await db.contextComments.update(commentId, { reactions })
  })
}

export async function removeContextCommentReaction(
  commentId: string,
  emoji: string,
  userId: string
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.contextComments, async () => {
    const row = await db.contextComments.get(commentId)
    if (!row) return
    const reactions = row.reactions
      .map((reaction) =>
        reaction.emoji === emoji
          ? { ...reaction, users: reaction.users.filter((user) => user !== userId) }
          : reaction
      )
      .filter((reaction) => reaction.users.length > 0)
    await db.contextComments.update(commentId, { reactions })
  })
}

export async function replyToContextComment(
  parentId: string,
  input: ReplyToContextCommentInput
): Promise<ContextComment> {
  const db = getDb()
  const parent = await db.contextComments.get(parentId)
  if (!parent) throw new Error(`Parent comment ${parentId} not found`)
  const reply: ContextComment = {
    id: nanoid(),
    resourceKind: parent.resourceKind,
    resourceId: parent.resourceId,
    projectId: parent.projectId,
    anchor: parent.anchor,
    parentId,
    authorId: input.authorId,
    authorName: input.authorName,
    authorAvatarUrl: input.authorAvatarUrl,
    content: input.content,
    createdAt: new Date(),
    reactions: [],
  }
  await db.contextComments.add(toRow(reply))
  return reply
}

export async function clearContextCommentsForResource(
  resourceKind: ContextCommentResourceKind,
  resourceId: string
): Promise<void> {
  await getDb()
    .contextComments.where("[resourceKind+resourceId]")
    .equals([resourceKind, resourceId])
    .delete()
}

export async function bulkImportContextComments(rows: ContextCommentRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const db = getDb()
  let inserted = 0
  await db.transaction("rw", db.contextComments, async () => {
    for (const row of rows) {
      if (await db.contextComments.get(row.id)) continue
      await db.contextComments.add(row)
      inserted += 1
    }
  })
  return inserted
}

export async function listAllContextCommentRows(): Promise<ContextCommentRow[]> {
  return getDb().contextComments.toArray()
}

export async function listAllCanvasCommentRows(): Promise<CanvasCommentRow[]> {
  return (await listAllContextCommentRows())
    .filter((row) => row.resourceKind === "canvas-document")
    .map(canvasCommentRowFromContext)
}

export const __TESTING__ = { toRow, fromRow }

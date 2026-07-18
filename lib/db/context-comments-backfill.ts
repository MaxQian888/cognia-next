import type { ContextCommentRow } from "@/types/context-comment"
import type { CanvasCommentRow } from "./canvas-types"

export function contextCommentRowFromCanvas(row: CanvasCommentRow): ContextCommentRow {
  return {
    id: row.id,
    resourceKind: "canvas-document",
    resourceId: row.documentId,
    projectId: row.projectId,
    anchor: {
      kind: "text-range",
      start: 0,
      end: 0,
      lineRange: row.range,
    },
    authorId: row.authorId,
    authorName: row.authorName,
    authorAvatarUrl: row.authorAvatarUrl,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    reactions: row.reactions ?? [],
    parentId: row.parentId,
  }
}

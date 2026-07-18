import type { CommentReaction, LineRange } from "@/types/canvas/collaboration"
import type { ContextResource } from "@/types/context-workbench"

export type ContextCommentResourceKind = ContextResource["kind"]

export interface ContextCommentResourceRef {
  kind: ContextCommentResourceKind
  id: string
  projectId?: string
}

export type ContextCommentAnchor =
  | { kind: "resource"; revision?: string }
  | {
      kind: "text-range"
      start: number
      end: number
      lineRange?: LineRange
      revision?: string
      quotedText?: string
    }
  | { kind: "workflow-node"; nodeId: string; revision?: string }
  | { kind: "workflow-edge"; edgeId: string; revision?: string }

export interface ContextComment {
  id: string
  resourceKind: ContextCommentResourceKind
  resourceId: string
  projectId?: string
  anchor: ContextCommentAnchor
  authorId: string
  authorName: string
  authorAvatarUrl?: string
  content: string
  createdAt: Date
  updatedAt?: Date
  resolvedAt?: Date
  resolvedBy?: string
  reactions: CommentReaction[]
  parentId?: string
}

export interface ContextCommentRow extends Omit<
  ContextComment,
  "createdAt" | "updatedAt" | "resolvedAt"
> {
  createdAt: number
  updatedAt?: number
  resolvedAt?: number
}

export function isContextCommentAnchorStale(
  comment: Pick<ContextComment, "anchor">,
  currentRevision: string
): boolean {
  return Boolean(comment.anchor.revision && comment.anchor.revision !== currentRevision)
}

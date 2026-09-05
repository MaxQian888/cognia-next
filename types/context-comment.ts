import type { CanvasCrdtAnchor, CommentReaction, LineRange } from "@/types/canvas/collaboration"
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
      /**
       * Where the range was when the comment was written.
       *
       * Still recorded when `crdt` is present, because it is what a reader
       * with no live document falls back to: an offline device, a resource
       * with no collaborative session open, or a comment written before the
       * document had one.
       */
      start: number
      end: number
      lineRange?: LineRange
      revision?: string
      quotedText?: string
      /**
       * The same range named inside the CRDT, which moves with the text.
       *
       * Optional and additive. Present only for resources that had a live
       * shared document when the comment was written, and its presence is what
       * exempts the comment from revision staleness: a relative position does
       * not go stale, it either resolves somewhere or says the text is gone.
       */
      crdt?: CanvasCrdtAnchor
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

/**
 * Whether a comment's anchor can still be trusted to point at what it meant.
 *
 * A revision mismatch is the only signal an absolute offset has: anybody
 * typing anywhere in the document invalidates every offset in it, so the whole
 * thread is greyed out and the author has to go and find the line again.
 *
 * A CRDT anchor has no such problem. It names the characters rather than their
 * index, so it survives edits above it and concurrent edits by other people,
 * and it is exempted here. When the text it named is actually deleted, the
 * resolver returns nothing, which is a different and more specific answer than
 * "the document changed".
 */
export function isContextCommentAnchorStale(
  comment: Pick<ContextComment, "anchor">,
  currentRevision: string
): boolean {
  if (comment.anchor.kind === "text-range" && comment.anchor.crdt) return false
  return Boolean(comment.anchor.revision && comment.anchor.revision !== currentRevision)
}

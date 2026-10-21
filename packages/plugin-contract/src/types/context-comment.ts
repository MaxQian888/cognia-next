import type { CanvasCrdtAnchor, CommentReaction, LineRange } from "./canvas/collaboration"
import type { ContextResource } from "./context-workbench"

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
      /** Version of the project-file quote/context anchoring payload. */
      anchorVersion?: 1
      /** Original selection, capped at 8 Ki UTF-16 code units. */
      quotedText?: string
      /** Whether quotedText contains the entire selection. */
      quoteComplete?: boolean
      /** Length of the entire original selection in UTF-16 code units. */
      quoteLength?: number
      /** SHA-256 of the entire original selection encoded as UTF-8. */
      quoteSha256?: string
      /** Up to 128 UTF-16 code units immediately before the selection. */
      prefixContext?: string
      /** Up to 128 UTF-16 code units immediately after the selection. */
      suffixContext?: string
      /** SHA-256 of the exact UTF-8 draft at creation, never a dirty buffer's disk hash. */
      baseContentSha256?: string
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
 * Legacy absolute offsets use revision mismatch conservatively. Version 1
 * project-file anchors instead use their content/quote resolver's outcome:
 * an edit can move a range without removing the text it points at.
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
  if (
    comment.anchor.kind === "text-range" &&
    (comment.anchor.crdt || comment.anchor.anchorVersion === 1)
  )
    return false
  return Boolean(comment.anchor.revision && comment.anchor.revision !== currentRevision)
}

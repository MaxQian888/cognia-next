/**
 * The plugin contract's share of `lib/db/canvas-comments.ts`, which re-exports these.
 */
import type { CanvasComment } from "../../types/canvas/collaboration"

export type AddCommentInput = Omit<CanvasComment, "id" | "createdAt" | "updatedAt" | "reactions">

export type ReplyInput = Omit<
  CanvasComment,
  "id" | "createdAt" | "updatedAt" | "reactions" | "range" | "parentId" | "documentId"
>

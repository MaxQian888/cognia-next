/**
 * Dexie row shapes for the Canvas tables. These mirror the runtime types
 * in `@/types/canvas/document` and `@/types/canvas/collaboration`, but use
 * primitive timestamps (number) rather than Date objects so IndexedDB can
 * index them. The CRUD layer (`canvas-documents.ts` etc.) does the
 * conversion at the boundary.
 */

export type {
  CanvasCommentRow,
  CanvasDocumentRow,
  CanvasSessionRow,
  CanvasVersionRow,
} from "@cognia/plugin-contract/lib/db/canvas-types"

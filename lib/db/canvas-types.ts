/**
 * Dexie row shapes for the Canvas tables. These mirror the runtime types
 * in `@/types/canvas/document` and `@/types/canvas/collaboration`, but use
 * primitive timestamps (number) rather than Date objects so IndexedDB can
 * index them. The CRUD layer (`canvas-documents.ts` etc.) does the
 * conversion at the boundary.
 */

import type {
  ArtifactAuthoringOrigin,
  ArtifactLanguage,
  ArtifactWorkspaceReturnContext,
  CanvasAIWorkbenchState,
  CanvasEditorContext,
  CanvasSuggestion,
} from "@/types/artifact/artifact"
import type { CanvasComment, SessionPermissions } from "@/types/canvas/collaboration"

export interface CanvasDocumentRow {
  id: string
  sessionId?: string
  /** Owning workspace id — Workspace isolation column (Dexie v86). See `lib/db/project-scope.ts`. */
  projectId?: string
  title: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
  createdAt: number
  updatedAt: number
  editorContext?: CanvasEditorContext
  aiSuggestions?: CanvasSuggestion[]
  currentVersionId?: string
  /**
   * The artifact this document was opened from, and how to get back to it.
   *
   * These used to exist only in the `cognia-artifacts` localStorage blob, so
   * the Dexie mirror dropped them — which was invisible while the blob was
   * authoritative and became a broken "return to artifact" the moment it
   * stopped being. Not indexed: nothing queries a document by its origin.
   */
  sourceArtifactId?: string
  returnContext?: ArtifactWorkspaceReturnContext | null
  authoringOrigin?: ArtifactAuthoringOrigin
  /**
   * Prompt draft, staged attachments, the open revision proposal and the action
   * log. Stored verbatim, `Date` fields included — IndexedDB clones them, and
   * the store's own rehydrator coerces the ISO strings a backup round-trip
   * leaves behind.
   */
  aiWorkbench?: CanvasAIWorkbenchState
}

export interface CanvasVersionRow {
  id: string
  documentId: string
  /** Owning workspace id — Workspace isolation column (Dexie v86); inherits the document's project. */
  projectId?: string
  content: string
  title: string
  createdAt: number
  description?: string
  isAutoSave?: boolean
}

/**
 * Persisted comment shape. `range` and `reactions` are stored as JSON-
 * serialisable plain objects (they already are in the Cognia type, so this
 * is a transparent passthrough).
 */
export interface CanvasCommentRow extends Omit<
  CanvasComment,
  "createdAt" | "updatedAt" | "resolvedAt"
> {
  /** Owning workspace id — Workspace isolation column (Dexie v86); inherits the document's project. */
  projectId?: string
  createdAt: number
  updatedAt?: number
  resolvedAt?: number
}

export interface CanvasSessionRow {
  id: string
  documentId: string
  /** Owning workspace id — Workspace isolation column (Dexie v86); inherits the document's project. */
  projectId?: string
  ownerId: string
  createdAt: number
  updatedAt: number
  isActive: boolean
  shareLink?: string
  permissions: SessionPermissions
  /** JSON-serialised participant list — Date objects are stringified. */
  participants?: string
}

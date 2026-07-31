/**
 * Canvas → Artifact projection.
 *
 * The Canvas workspace edits `CanvasDocument`s (Monaco/CodeMirror), while the
 * Artifacts subsystem already ships a complete sandboxed preview stack
 * (`ArtifactPreview` + `runtime-adapters`) keyed on `ArtifactType`. Rather than
 * reimplement rendering, we project a `CanvasDocument` onto a synthetic
 * `Artifact` so the *existing* preview renders it. `ArtifactPreview` reads only
 * `type` / `content` / `language` / `metadata` and never touches the artifact
 * store, so a throwaway object is safe.
 *
 * Documents whose language has no visual form (plain code, JSON, CSS, …) map to
 * `null` — the preview toggle hides Split/Preview for those.
 */

import type { Artifact, ArtifactType, CanvasDocument } from "@/types/artifact/artifact"

/**
 * Resolve the `ArtifactType` that should render a Canvas document's live
 * preview, or `null` when the document has no visual representation.
 *
 * Language wins over `type` so an HTML/SVG/React/Mermaid/LaTeX document renders
 * even if it was created as a "code" document; Markdown and any "text" document
 * fall through to the Markdown renderer (`document`).
 */
export function canvasArtifactType(
  doc: Pick<CanvasDocument, "language" | "type">
): ArtifactType | null {
  switch (doc.language) {
    case "html":
      return "html"
    case "svg":
      return "svg"
    case "jsx":
    case "tsx":
      return "react"
    case "mermaid":
      return "mermaid"
    case "latex":
      return "math"
    case "markdown":
      return "document"
    default:
      // Any remaining "text" document is Markdown-authored → render as a doc.
      return doc.type === "text" ? "document" : null
  }
}

/** Whether the document can be shown in the live preview pane. */
export function isCanvasDocumentPreviewable(
  doc: Pick<CanvasDocument, "language" | "type">
): boolean {
  return canvasArtifactType(doc) !== null
}

/**
 * Build a synthetic `Artifact` from a `CanvasDocument` for the preview pane.
 * Returns `null` when the document is not previewable.
 */
export function canvasDocumentToArtifact(doc: CanvasDocument): Artifact | null {
  const type = canvasArtifactType(doc)
  if (!type) return null

  return {
    id: doc.id,
    sessionId: doc.sessionId,
    projectId: doc.projectId,
    // Synthetic — canvas previews are not tied to a chat message.
    messageId: `canvas:${doc.id}`,
    type,
    title: doc.title,
    content: doc.content,
    language: doc.language,
    version: 1,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    metadata: {
      previewable: true,
      sandboxed: true,
    },
  }
}

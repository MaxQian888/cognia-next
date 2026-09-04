"use client"

/**
 * Canvas Workspace — top-level container rendered by the desktop
 * shell when the user selects the Canvas guild. Composes the
 * editor (CanvasPanel), document rail, side panels, and empty state.
 */

import { useCanvasDocumentSummaries } from "@/hooks/canvas/use-canvas-document-summaries"
import { CanvasErrorBoundary } from "./canvas-error-boundary"
import { CanvasPanel } from "./canvas-panel"
import { CanvasEmptyState } from "./canvas-empty-state"

export function CanvasWorkspace() {
  // Workspace-scoped: the empty state answers "does THIS workspace have a
  // document", not "does any workspace". Reusing the summaries hook keeps that
  // answer identical to the one the rail renders.
  const documents = useCanvasDocumentSummaries()
  const hasDocuments = documents.length > 0

  return (
    <CanvasErrorBoundary>
      {hasDocuments ? <CanvasPanel /> : <CanvasEmptyState />}
    </CanvasErrorBoundary>
  )
}

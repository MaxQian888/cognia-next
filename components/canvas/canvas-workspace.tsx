"use client"

/**
 * Canvas Workspace — top-level container rendered by the desktop
 * shell when the user selects the Canvas guild. Composes the
 * editor (CanvasPanel), document rail, side panels, and empty state.
 */

import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { CanvasErrorBoundary } from "./canvas-error-boundary"
import { CanvasPanel } from "./canvas-panel"
import { CanvasEmptyState } from "./canvas-empty-state"

export function CanvasWorkspace() {
  const documents = useArtifactStore((s) => s.canvasDocuments)
  const hasDocuments = Object.keys(documents).length > 0

  return (
    <CanvasErrorBoundary>
      {hasDocuments ? <CanvasPanel /> : <CanvasEmptyState />}
    </CanvasErrorBoundary>
  )
}

"use client"

/**
 * ArtifactPanel — the Sheet (modal/offcanvas) host for the artifacts surface.
 *
 * Used as the mobile/tablet fallback and anywhere a docked panel isn't
 * mounted. The body is the shared `<ArtifactPanelContent />`, so the Sheet and
 * the desktop dock render identically. The docked variant lives in
 * `artifact-dock.tsx` / `artifact-workspace-dock.tsx`.
 */

import { useArtifactPanelState } from "@/hooks/artifacts/use-artifact-panel"
import { ArtifactContextWorkbench, SessionContextWorkbench } from "./artifact-dock"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

export function ArtifactPanel() {
  const { panelOpen, panelView, panelMode, closePanel } = useArtifactPanelState()
  const activeArtifactId = useArtifactStore((state) => state.activeArtifactId)
  const open = panelOpen && panelView === "artifact"
  const host = { open, onOpenChange: (next: boolean) => !next && closePanel(), panelMode }

  // One Sheet, both resources. Previously an artifact opened the workbench
  // Sheet while the empty state fell back to a plain Sheet that could only ever
  // show the artifact list — leaving the browser, comments and metadata panels
  // unreachable on a phone.
  return activeArtifactId ? (
    <ArtifactContextWorkbench artifactId={activeArtifactId} mobile={host} />
  ) : (
    <SessionContextWorkbench mobile={host} />
  )
}

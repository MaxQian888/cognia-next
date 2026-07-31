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
import { useActiveArtifactId } from "@/hooks/artifacts/use-session-artifacts"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

export function ArtifactPanel() {
  const { panelMode, closePanel } = useArtifactPanelState()
  const activeArtifactId = useActiveArtifactId()
  // Visibility belongs to `mobileSheetOpen` alone — it is the one field every
  // reveal writes and the only one that can see `userDismissed`. Reading
  // `panelOpen` here let `createArtifact` / `setActiveArtifact` raise this Sheet
  // straight from the artifact store, so a new artifact threw a 92dvh modal
  // over the conversation even right after the user swiped it away.
  const open = useArtifactDockLayoutStore((state) => state.mobileSheetOpen)
  const setDockCollapsed = useArtifactDockLayoutStore((state) => state.setDockCollapsed)
  const host = {
    open,
    // Swiping the Sheet away IS this platform's dismissal gesture, so record it
    // the same way the desktop collapse does. `setDockCollapsed(true)` lowers
    // `mobileSheetOpen` with it, which is what actually closes the Sheet.
    onOpenChange: (next: boolean) => {
      if (next) return
      setDockCollapsed(true)
      closePanel()
    },
    panelMode,
  }

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

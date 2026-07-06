import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import type { Artifact } from "@/types"

export function revealArtifactInWorkspace(id: string): Artifact | null {
  const store = useArtifactStore.getState()
  const artifact = store.artifacts[id]

  if (!artifact) {
    return null
  }

  store.setActiveArtifact(id)
  store.openPanel("artifact")
  // Make "open in panel" target the docked panel when one is mounted: expand
  // the desktop dock and open the mobile Sheet fallback. Harmless no-ops when
  // the dock isn't on screen.
  const dock = useArtifactDockLayoutStore.getState()
  dock.setDockCollapsed(false)
  dock.setMobileSheetOpen(true)
  return artifact
}

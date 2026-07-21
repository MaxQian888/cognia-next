"use client"

/**
 * Registers the rebindable `artifacts.toggleDock` shortcut (default Cmd/Ctrl+J)
 * for the docked artifacts panel. The single dispatcher owns the listener plus
 * the editable / Monaco guards; the descriptor's `when: "!view.canvas"` keeps it
 * from contending with the Canvas right-rail (which also defaults to Cmd+J).
 */

import { useBreakpoint } from "@/hooks/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"

export function useArtifactDockShortcuts(): void {
  const breakpoint = useBreakpoint()
  const toggleDock = useArtifactDockLayoutStore((s) => s.toggleDock)
  const setMobileSheetOpen = useArtifactDockLayoutStore((s) => s.setMobileSheetOpen)
  const openArtifactPanel = useArtifactStore((s) => s.openPanel)
  const closeArtifactPanel = useArtifactStore((s) => s.closePanel)

  useAppShortcut(
    "artifacts.toggleDock",
    () => {
      if (breakpoint === "desktop") {
        toggleDock()
        return
      }

      const dock = useArtifactDockLayoutStore.getState()
      if (dock.dockProfile === "workspace") {
        const nextOpen = !dock.mobileSheetOpen
        const artifact = useArtifactStore.getState()
        if (nextOpen && artifact.panelOpen && artifact.panelView === "artifact") {
          artifact.closePanel()
        }
        setMobileSheetOpen(nextOpen)
        return
      }

      setMobileSheetOpen(false)
      const artifact = useArtifactStore.getState()
      if (artifact.panelOpen && artifact.panelView === "artifact") closeArtifactPanel()
      else openArtifactPanel("artifact")
    },
    { preventDefault: true, editorSelectors: [".monaco-editor"] }
  )
}

export default useArtifactDockShortcuts

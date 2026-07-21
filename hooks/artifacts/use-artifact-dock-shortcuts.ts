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

      // One Sheet on narrow screens, so one toggle. There used to be a second
      // branch here for a standalone Workspace Sheet keyed on the dock surface;
      // that Sheet is gone, and the branch had become an infinite no-op —
      // closing the panel while raising `mobileSheetOpen`, which the narrow dock
      // immediately reconciles back into re-opening it.
      const artifact = useArtifactStore.getState()
      if (artifact.panelOpen && artifact.panelView === "artifact") {
        setMobileSheetOpen(false)
        closeArtifactPanel()
      } else {
        openArtifactPanel("artifact")
      }
    },
    { preventDefault: true, editorSelectors: [".monaco-editor"] }
  )
}

export default useArtifactDockShortcuts

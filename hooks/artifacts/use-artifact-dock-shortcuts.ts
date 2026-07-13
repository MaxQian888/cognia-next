"use client"

/**
 * Registers the rebindable `artifacts.toggleDock` shortcut (default Cmd/Ctrl+J)
 * for the docked artifacts panel. The single dispatcher owns the listener plus
 * the editable / Monaco guards; the descriptor's `when: "!view.canvas"` keeps it
 * from contending with the Canvas right-rail (which also defaults to Cmd+J).
 */

import { useIsMobile } from "@/hooks/ui"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"

export function useArtifactDockShortcuts(): void {
  const isMobile = useIsMobile()
  const toggleDock = useArtifactDockLayoutStore((s) => s.toggleDock)
  const setMobileSheetOpen = useArtifactDockLayoutStore((s) => s.setMobileSheetOpen)

  useAppShortcut(
    "artifacts.toggleDock",
    () => {
      if (isMobile) {
        setMobileSheetOpen(!useArtifactDockLayoutStore.getState().mobileSheetOpen)
      } else {
        toggleDock()
      }
    },
    { preventDefault: true, editorSelectors: [".monaco-editor"] }
  )
}

export default useArtifactDockShortcuts

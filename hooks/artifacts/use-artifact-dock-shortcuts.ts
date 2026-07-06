"use client"

/**
 * Keyboard shortcut for the docked artifacts panel.
 *
 *  - Cmd/Ctrl + J → toggle the dock (or its mobile Sheet fallback)
 *
 * Mirrors the Canvas shell's right-rail binding. The Canvas guild and the chat
 * workspace never mount together, so there is no collision. Bails when focus is
 * inside Monaco / a text field so the editor's own bindings keep working.
 */

import { useEffect } from "react"
import { useIsMobile } from "@/hooks/ui"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

export function useArtifactDockShortcuts(): void {
  const isMobile = useIsMobile()
  const toggleDock = useArtifactDockLayoutStore((s) => s.toggleDock)
  const setMobileSheetOpen = useArtifactDockLayoutStore((s) => s.setMobileSheetOpen)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== "j") return

      const active = (typeof document !== "undefined" ? document.activeElement : null) as
        | (Element & { closest: (sel: string) => Element | null; tagName?: string })
        | null
      if (active) {
        const tag = active.tagName
        if (tag === "INPUT" || tag === "TEXTAREA") return
        if (typeof active.closest === "function" && active.closest(".monaco-editor")) return
      }

      e.preventDefault()
      if (isMobile) {
        setMobileSheetOpen(!useArtifactDockLayoutStore.getState().mobileSheetOpen)
      } else {
        toggleDock()
      }
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [isMobile, toggleDock, setMobileSheetOpen])
}

export default useArtifactDockShortcuts

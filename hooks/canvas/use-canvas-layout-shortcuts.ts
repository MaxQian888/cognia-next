"use client"

/**
 * Registers the rebindable Canvas-shell rail toggles:
 *   • canvasLayout.toggleLeft   Cmd/Ctrl+B  → document rail (or its mobile Sheet)
 *   • canvasLayout.toggleRight  Cmd/Ctrl+J  → tools rail (or its mobile Sheet)
 *
 * The single dispatcher owns the listener. These fire even from plain fields
 * (`allowInEditable`), matching the pre-migration behavior, but never from
 * Monaco (`editorSelectors`) so the editor's own Cmd+B/Cmd+J keep working. The
 * descriptors' `when: "view.canvas"` scopes them to the Canvas guild.
 */

import { useIsMobile } from "@/hooks/ui"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"

const RAIL_OPTIONS = {
  preventDefault: true,
  allowInEditable: true,
  editorSelectors: [".monaco-editor"],
}

export function useCanvasLayoutShortcuts(): void {
  const isMobile = useIsMobile()
  const toggleLeft = useCanvasLayoutStore((s) => s.toggleLeft)
  const toggleRight = useCanvasLayoutStore((s) => s.toggleRight)
  const setMobileLeftOpen = useCanvasLayoutStore((s) => s.setMobileLeftOpen)
  const setMobileRightOpen = useCanvasLayoutStore((s) => s.setMobileRightOpen)

  useAppShortcut(
    "canvasLayout.toggleLeft",
    () => {
      if (isMobile) {
        setMobileLeftOpen(!useCanvasLayoutStore.getState().mobileLeftOpen)
      } else {
        toggleLeft()
      }
    },
    RAIL_OPTIONS
  )

  useAppShortcut(
    "canvasLayout.toggleRight",
    () => {
      if (isMobile) {
        setMobileRightOpen(!useCanvasLayoutStore.getState().mobileRightOpen)
      } else {
        toggleRight()
      }
    },
    RAIL_OPTIONS
  )
}

export default useCanvasLayoutShortcuts

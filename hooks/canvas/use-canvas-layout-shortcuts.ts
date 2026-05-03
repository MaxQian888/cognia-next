"use client"

/**
 * Keyboard shortcuts for the Canvas shell layout.
 *
 *  - Cmd/Ctrl + B  → toggle the document rail (or its mobile Sheet)
 *  - Cmd/Ctrl + J  → toggle the right tools rail (or its mobile Sheet)
 *
 * Mirrors VS Code / Cursor's bindings. Bails when focus is inside Monaco so
 * the editor's own "go to declaration" / "toggle terminal" keep working.
 */

import { useEffect } from "react"
import { useIsMobile } from "@/hooks/ui"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"

export function useCanvasLayoutShortcuts(): void {
  const isMobile = useIsMobile()
  const toggleLeft = useCanvasLayoutStore((s) => s.toggleLeft)
  const toggleRight = useCanvasLayoutStore((s) => s.toggleRight)
  const setMobileLeftOpen = useCanvasLayoutStore((s) => s.setMobileLeftOpen)
  const setMobileRightOpen = useCanvasLayoutStore((s) => s.setMobileRightOpen)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod || e.shiftKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key !== "b" && key !== "j") return

      // Don't fight Monaco's own Cmd+B / Cmd+J when focus is in the editor.
      const active = (typeof document !== "undefined" ? document.activeElement : null) as
        | (Element & { closest: (sel: string) => Element | null })
        | null
      if (active && typeof active.closest === "function" && active.closest(".monaco-editor")) {
        return
      }

      e.preventDefault()
      if (key === "b") {
        if (isMobile) {
          setMobileLeftOpen(!useCanvasLayoutStore.getState().mobileLeftOpen)
        } else {
          toggleLeft()
        }
        return
      }
      // key === "j"
      if (isMobile) {
        setMobileRightOpen(!useCanvasLayoutStore.getState().mobileRightOpen)
      } else {
        toggleRight()
      }
    }

    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [isMobile, toggleLeft, toggleRight, setMobileLeftOpen, setMobileRightOpen])
}

export default useCanvasLayoutShortcuts

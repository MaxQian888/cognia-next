"use client"

import { loggers } from "@/lib/logger"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { useEffect, useState } from "react"

const log = loggers.ui

/**
 * Tauri 2.x's `ResizeDirection` enum — kept inline so the file works in
 * web mode (where the dynamic `import("@tauri-apps/api/window")` is never
 * triggered).
 */
type ResizeDirection =
  | "East"
  | "West"
  | "North"
  | "South"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest"

interface EdgeSpec {
  direction: ResizeDirection
  className: string
  testId: string
}

/**
 * Eight invisible drag-handles laid out around the shell edges. Each calls
 * `getCurrentWindow().startResizeDragging(direction)` on `mousedown`, giving
 * frameless windows back the resize affordance the OS removes when
 * `decorations: false`. Hidden in maximized / fullscreen mode where resizing
 * isn't allowed anyway.
 */
const EDGES: EdgeSpec[] = [
  {
    direction: "North",
    className: "left-2 right-2 top-0 h-[3px] cursor-ns-resize",
    testId: "resize-north",
  },
  {
    direction: "South",
    className: "left-2 right-2 bottom-0 h-[3px] cursor-ns-resize",
    testId: "resize-south",
  },
  {
    direction: "West",
    className: "top-2 bottom-2 left-0 w-[3px] cursor-ew-resize",
    testId: "resize-west",
  },
  {
    direction: "East",
    className: "top-2 bottom-2 right-0 w-[3px] cursor-ew-resize",
    testId: "resize-east",
  },
  {
    direction: "NorthWest",
    className: "top-0 left-0 size-2 cursor-nwse-resize",
    testId: "resize-nw",
  },
  {
    direction: "NorthEast",
    className: "top-0 right-0 size-2 cursor-nesw-resize",
    testId: "resize-ne",
  },
  {
    direction: "SouthWest",
    className: "bottom-0 left-0 size-2 cursor-nesw-resize",
    testId: "resize-sw",
  },
  {
    direction: "SouthEast",
    className: "bottom-0 right-0 size-2 cursor-nwse-resize",
    testId: "resize-se",
  },
]

export function WindowResizeEdges() {
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unResize: (() => void) | undefined
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window")
        const win = getCurrentWindow()
        const refresh = async () => {
          if (cancelled) return
          const [maxed, full] = await Promise.all([win.isMaximized(), win.isFullscreen()])
          setActive(!maxed && !full)
        }
        await refresh()
        unResize = await win.onResized(() => {
          void refresh()
        })
      } catch (err) {
        log.warn("resize-edges setup failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
      unResize?.()
    }
  }, [])

  if (!active) return null

  const onMouseDown = (direction: ResizeDirection) => async (event: React.MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window")
      await getCurrentWindow().startResizeDragging(direction)
    } catch (err) {
      log.error("resize-edges startResizeDragging failed", err)
    }
  }

  return (
    <div
      aria-hidden
      data-app-chrome
      data-testid="window-resize-edges"
      className="pointer-events-none fixed inset-0 z-50"
    >
      {EDGES.map((edge) => (
        <div
          key={edge.direction}
          data-testid={edge.testId}
          aria-hidden
          onMouseDown={onMouseDown(edge.direction)}
          className={cn("pointer-events-auto absolute", edge.className)}
        />
      ))}
    </div>
  )
}

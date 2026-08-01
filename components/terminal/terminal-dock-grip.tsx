"use client"

/**
 * The dock's move handle — drag it to an edge to re-dock the terminal panel.
 *
 * A dedicated grip rather than "drag the whole tab strip": the strip's children
 * are click-to-select tabs that are themselves sortable, and a strip-wide drag
 * source swallows those interactions even behind an activation distance.
 *
 * Keyboard users get Enter/Space to toggle the edge instead. dnd-kit's keyboard
 * sensor navigates *sortable* collections; it has nothing sensible to do with
 * two free-floating drop zones, so the toggle is the honest affordance. The
 * same action is also on the dock toolbar and the title bar's Views menu.
 */

import { useDraggable } from "@dnd-kit/core"
import { GripVerticalIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { nextDockPosition, TERMINAL_DOCK_DRAG_ID } from "@/lib/terminal/dock-position"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

export function TerminalDockGrip() {
  const t = useTranslations("terminal.dock")
  const panelPosition = useTerminalStore((s) => s.panelPosition)
  const setPanelPosition = useTerminalStore((s) => s.setPanelPosition)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: TERMINAL_DOCK_DRAG_ID,
  })

  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      aria-label={t("dragToMove")}
      title={t("dragToMove")}
      data-testid="terminal-dock-grip"
      data-dragging={isDragging ? "true" : "false"}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          setPanelPosition(nextDockPosition(panelPosition))
        }
      }}
      className={cn(
        // `touch-none` so a touch drag moves the dock instead of scrolling the
        // tab strip underneath it.
        "flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded",
        "text-muted-foreground/60 hover:bg-muted hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isDragging && "cursor-grabbing bg-muted text-foreground"
      )}
    >
      <GripVerticalIcon className="h-3 w-3" aria-hidden />
    </button>
  )
}

export default TerminalDockGrip

"use client"

/**
 * Drag-to-move plumbing for the terminal dock.
 *
 * Wraps the desktop shell's content row in a single `DndContext` and, while a
 * drag from the dock's grip is in flight, paints two edge drop zones. Dropping
 * on one re-docks the panel there.
 *
 * The zones only exist during a drag, so the common case costs one context
 * provider and nothing else — no permanently-mounted overlays competing for
 * pointer events with the page underneath.
 *
 * Drop resolution lives in `lib/terminal/dock-position.ts` because jsdom cannot
 * run a real dnd-kit drag (same constraint `components/shell/bar-customizer.tsx`
 * documents), so the decision has to be unit-testable on its own.
 */

import * as React from "react"
import { DndContext, PointerSensor, useDroppable, useSensor, useSensors } from "@dnd-kit/core"
import type { DragEndEvent } from "@dnd-kit/core"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { resolveDropPosition, TERMINAL_DOCK_DROP_IDS } from "@/lib/terminal/dock-position"
import { useTerminalStore, type TerminalPanelPosition } from "@/stores/terminal/terminal-store"

export function TerminalDockMoveProvider({ children }: { children: React.ReactNode }) {
  const [dragging, setDragging] = React.useState(false)
  const setPanelPosition = useTerminalStore((s) => s.setPanelPosition)

  // A small activation distance keeps a plain click on the grip from starting a
  // drag, so the grip's keyboard/Enter fallback still reads as a button.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setDragging(false)
      const next = resolveDropPosition(
        event.over?.id ? String(event.over.id) : null,
        useTerminalStore.getState().panelPosition
      )
      if (next) setPanelPosition(next)
    },
    [setPanelPosition]
  )

  return (
    <DndContext
      sensors={sensors}
      onDragStart={() => setDragging(true)}
      onDragCancel={() => setDragging(false)}
      onDragEnd={handleDragEnd}
    >
      {children}
      {dragging ? (
        <>
          <DockDropZone position="bottom" />
          <DockDropZone position="right" />
        </>
      ) : null}
    </DndContext>
  )
}

function DockDropZone({ position }: { position: TerminalPanelPosition }) {
  const t = useTranslations("terminal.dock")
  const id = TERMINAL_DOCK_DROP_IDS[position]
  const { setNodeRef, isOver } = useDroppable({ id })

  return (
    <div
      ref={setNodeRef}
      data-testid={id}
      data-over={isOver ? "true" : "false"}
      // `pointer-events-none` on purpose: dnd-kit resolves the drop from the
      // droppable's measured rect, not from hit-testing, so the overlay must not
      // swallow events from the page it covers.
      className={cn(
        "pointer-events-none fixed z-50 rounded-md border-2 border-dashed transition-colors",
        isOver ? "border-primary bg-primary/15" : "border-primary/50 bg-primary/5",
        position === "bottom" ? "inset-x-0 bottom-0 h-[38vh]" : "inset-y-0 right-0 w-[38vw]"
      )}
    >
      <span className="sr-only">
        {position === "bottom" ? t("dropZoneBottom") : t("dropZoneRight")}
      </span>
    </div>
  )
}

export default TerminalDockMoveProvider

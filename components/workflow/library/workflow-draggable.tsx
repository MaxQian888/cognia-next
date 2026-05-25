"use client"

// Drag source wrapper for a workflow card/row. Whole-item drag with a small
// activation distance so a plain click still selects/opens. Used by the grid
// and list containers; the orchestrator supplies the DndContext.

import { useDraggable } from "@dnd-kit/core"
import { cn } from "@/lib/utils"

export interface WorkflowDraggableProps {
  id: string
  children: React.ReactNode
}

export function WorkflowDraggable({ id, children }: WorkflowDraggableProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `workflow-${id}`,
    data: { type: "workflow", workflowId: id },
  })
  return (
    <div
      ref={setNodeRef}
      className={cn("touch-none", isDragging && "opacity-40")}
      data-testid={`workflow-draggable-${id}`}
      {...listeners}
      {...attributes}
    >
      {children}
    </div>
  )
}

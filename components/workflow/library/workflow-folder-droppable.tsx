"use client"

// Drop target wrapper for a folder destination (folder card/row and breadcrumb
// segments). Highlights while a workflow is dragged over it. The `folderId` is
// carried in the droppable data so the orchestrator's onDragEnd knows where to
// move. The orchestrator supplies the DndContext.

import { useDroppable } from "@dnd-kit/core"
import { cn } from "@/lib/utils"

export interface WorkflowFolderDroppableProps {
  folderId: string
  children: React.ReactNode
  className?: string
}

export function WorkflowFolderDroppable({
  folderId,
  children,
  className,
}: WorkflowFolderDroppableProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-drop-${folderId}`,
    data: { type: "folder", folderId },
  })
  return (
    <div
      ref={setNodeRef}
      data-testid={`folder-drop-${folderId}`}
      data-over={isOver || undefined}
      className={cn(
        "rounded-lg transition",
        isOver && "ring-2 ring-primary ring-offset-1",
        className
      )}
    >
      {children}
    </div>
  )
}

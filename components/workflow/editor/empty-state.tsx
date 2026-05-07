"use client"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { WorkflowIcon } from "lucide-react"

export function EditorEmptyState({ onAddNode }: { onAddNode?: () => void }) {
  return (
    <Empty className="absolute inset-0 m-auto h-fit max-w-md pointer-events-none">
      <EmptyHeader>
        <EmptyMedia>
          <WorkflowIcon className="size-8" aria-hidden="true" />
        </EmptyMedia>
      </EmptyHeader>
      <EmptyTitle>Empty workflow</EmptyTitle>
      <EmptyDescription>
        Drop a trigger node from the left sidebar to start, then connect it to actions.
      </EmptyDescription>
      {onAddNode ? (
        <button
          type="button"
          onClick={onAddNode}
          className="pointer-events-auto rounded-md border bg-card px-3 py-1.5 text-sm hover:bg-accent"
        >
          Add manual trigger
        </button>
      ) : null}
    </Empty>
  )
}

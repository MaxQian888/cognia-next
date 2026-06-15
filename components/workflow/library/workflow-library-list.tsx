"use client"

// List view — one flattened, virtualized window over folders followed by
// workflows. Keeping folders and workflows in the SAME virtual list (rather
// than rendering folders above a separate virtual area) means there is no
// non-virtual content above the window, so row offsets need no scroll-margin
// correction. @tanstack/react-virtual mounts only the visible rows.

import { useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { WorkflowFolder } from "@/types/workflow/folder"
import type { RunStatus, WorkflowRow as WorkflowRowType } from "@/types/workflow/visual"
import { WorkflowFolderRow } from "./workflow-folder-row"
import { WorkflowRow } from "./workflow-row"
import { WorkflowDraggable } from "./workflow-draggable"
import { WorkflowFolderDroppable } from "./workflow-folder-droppable"

const ESTIMATED_ROW_HEIGHT = 64

type ListEntry =
  | { kind: "folder"; key: string; folder: WorkflowFolder }
  | { kind: "workflow"; key: string; workflow: WorkflowRowType }

export interface WorkflowLibraryListProps {
  folders: WorkflowFolder[]
  workflows: WorkflowRowType[]
  runCounts?: ReadonlyMap<string, number>
  lastStatuses?: ReadonlyMap<string, RunStatus>
}

export function WorkflowLibraryList({
  folders,
  workflows,
  runCounts,
  lastStatuses,
}: WorkflowLibraryListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const entries: ListEntry[] = [
    ...folders.map((folder) => ({ kind: "folder" as const, key: `f:${folder.id}`, folder })),
    ...workflows.map((workflow) => ({
      kind: "workflow" as const,
      key: `w:${workflow.id}`,
      workflow,
    })),
  ]

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
  })

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto px-6 py-4"
      data-testid="workflow-library-list"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = entries[virtualRow.index]
          return (
            <div
              key={entry.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="pb-2"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {entry.kind === "folder" ? (
                <WorkflowFolderDroppable folderId={entry.folder.id}>
                  <WorkflowFolderRow folder={entry.folder} />
                </WorkflowFolderDroppable>
              ) : (
                <WorkflowDraggable id={entry.workflow.id}>
                  <WorkflowRow
                    workflow={entry.workflow}
                    runCount={runCounts?.get(entry.workflow.id)}
                    lastStatus={lastStatuses?.get(entry.workflow.id)}
                  />
                </WorkflowDraggable>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

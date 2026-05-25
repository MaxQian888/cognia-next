"use client"

// Grid view. Folders render in a responsive grid section, workflows below in
// another. Cards are memoized (see WorkflowCard) so re-renders stay cheap, and
// the orchestrator scopes the Dexie query to the current folder so the mounted
// card count is bounded by one folder's contents rather than the whole table —
// that's the perf lever here. The high-density flat view (list) is virtualized.

import { useTranslations } from "next-intl"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { WorkflowFolder } from "@/types/workflow/folder"
import type { WorkflowRow } from "@/types/workflow/visual"
import { WorkflowFolderCard } from "./workflow-folder-card"
import { WorkflowCard } from "./workflow-card"
import { WorkflowDraggable } from "./workflow-draggable"
import { WorkflowFolderDroppable } from "./workflow-folder-droppable"

export interface WorkflowLibraryGridProps {
  folders: WorkflowFolder[]
  workflows: WorkflowRow[]
}

export function WorkflowLibraryGrid({ folders, workflows }: WorkflowLibraryGridProps) {
  const t = useTranslations("workflows.library")

  return (
    <ScrollArea className="h-full">
      <div className="px-6 py-4" data-testid="workflow-library-grid">
        {folders.length > 0 ? (
          <section className="mb-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("folders.section")}
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {folders.map((folder) => (
                <WorkflowFolderDroppable key={folder.id} folderId={folder.id}>
                  <WorkflowFolderCard folder={folder} />
                </WorkflowFolderDroppable>
              ))}
            </div>
          </section>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workflows.map((workflow) => (
            <WorkflowDraggable key={workflow.id} id={workflow.id}>
              <WorkflowCard workflow={workflow} />
            </WorkflowDraggable>
          ))}
        </div>
      </div>
    </ScrollArea>
  )
}

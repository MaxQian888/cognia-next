"use client"

// Grid tile for a sub-folder. Click (or Enter/Space) navigates into it via the
// store; the ⋯ menu handles rename/delete. `data-folder-id` lets the
// orchestrator's drag-and-drop layer treat it as a move destination.

import { useTranslations } from "next-intl"
import { FolderIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { WorkflowFolder } from "@/types/workflow/folder"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { WorkflowFolderMenu } from "./workflow-folder-menu"

export interface WorkflowFolderCardProps {
  folder: WorkflowFolder
}

export function WorkflowFolderCard({ folder }: WorkflowFolderCardProps) {
  const t = useTranslations("workflows.library.folders")
  const enterFolder = useWorkflowLibraryStore((s) => s.enterFolder)

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => enterFolder(folder.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          enterFolder(folder.id)
        }
      }}
      data-folder-id={folder.id}
      data-testid={`workflow-folder-card-${folder.id}`}
      aria-label={`${t("open")}: ${folder.name}`}
      className={cn(
        "group flex h-32 cursor-pointer flex-col justify-between p-4 transition",
        "hover:border-primary/50 hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="rounded-md bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400">
          <FolderIcon className="size-5" aria-hidden="true" />
        </span>
        <WorkflowFolderMenu folder={folder} />
      </div>
      <div className="truncate text-sm font-medium" title={folder.name}>
        {folder.name}
      </div>
    </Card>
  )
}

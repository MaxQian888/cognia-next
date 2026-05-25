"use client"

// List-view row for a sub-folder — same behavior as the grid folder-card in a
// compact horizontal layout.

import { useTranslations } from "next-intl"
import { FolderIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { WorkflowFolder } from "@/types/workflow/folder"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { WorkflowFolderMenu } from "./workflow-folder-menu"

export interface WorkflowFolderRowProps {
  folder: WorkflowFolder
}

export function WorkflowFolderRow({ folder }: WorkflowFolderRowProps) {
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
      data-testid={`workflow-folder-row-${folder.id}`}
      aria-label={`${t("open")}: ${folder.name}`}
      className={cn(
        "group flex cursor-pointer flex-row items-center gap-3 p-3 shadow-none transition",
        "hover:border-primary/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      )}
    >
      <span className="rounded-md bg-amber-500/10 p-1.5 text-amber-600 dark:text-amber-400">
        <FolderIcon className="size-4" aria-hidden="true" />
      </span>
      <span className="flex-1 truncate text-sm font-medium" title={folder.name}>
        {folder.name}
      </span>
      <WorkflowFolderMenu folder={folder} />
    </Card>
  )
}

"use client"

// Folder breadcrumb for the workflow library. Renders the root crumb plus the
// ancestor chain from `getFolderPath`; clicking a segment navigates via the
// store. Segments double as drag-and-drop destinations (the drop wiring is
// layered on in the orchestrator via `data-folder-id`).

import { useTranslations } from "next-intl"
import { ChevronRightIcon, HomeIcon } from "lucide-react"
import { Breadcrumb, BreadcrumbItem, BreadcrumbList } from "@/components/ui/breadcrumb"
import { cn } from "@/lib/utils"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { WorkflowFolderDroppable } from "./workflow-folder-droppable"

export interface WorkflowFolderBreadcrumbProps {
  path: WorkflowFolder[]
}

export function WorkflowFolderBreadcrumb({ path }: WorkflowFolderBreadcrumbProps) {
  const t = useTranslations("workflows.library.folders")
  const enterFolder = useWorkflowLibraryStore((s) => s.enterFolder)
  const goToRoot = useWorkflowLibraryStore((s) => s.goToRoot)
  const currentFolderId = useWorkflowLibraryStore((s) => s.currentFolderId)

  return (
    <Breadcrumb data-testid="workflow-breadcrumb">
      <BreadcrumbList>
        <BreadcrumbItem>
          <WorkflowFolderDroppable folderId={ROOT_FOLDER_ID} className="inline-flex">
            <button
              type="button"
              onClick={goToRoot}
              data-folder-id={ROOT_FOLDER_ID}
              data-testid="workflow-breadcrumb-root"
              className={cn(
                "inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground",
                currentFolderId === ROOT_FOLDER_ID && "font-medium text-foreground"
              )}
            >
              <HomeIcon className="size-3.5" aria-hidden="true" />
              {t("root")}
            </button>
          </WorkflowFolderDroppable>
        </BreadcrumbItem>
        {path.map((folder, i) => {
          const isLast = i === path.length - 1
          return (
            <BreadcrumbItem key={folder.id}>
              <ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <WorkflowFolderDroppable folderId={folder.id} className="inline-flex">
                <button
                  type="button"
                  onClick={() => enterFolder(folder.id)}
                  data-folder-id={folder.id}
                  data-testid={`workflow-breadcrumb-${folder.id}`}
                  aria-current={isLast ? "page" : undefined}
                  className={cn(
                    "max-w-[12rem] truncate rounded px-1 py-0.5 transition-colors hover:text-foreground",
                    isLast && "font-medium text-foreground"
                  )}
                >
                  {folder.name}
                </button>
              </WorkflowFolderDroppable>
            </BreadcrumbItem>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

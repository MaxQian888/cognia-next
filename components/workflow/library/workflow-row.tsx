"use client"

// List-view row for a workflow — the compact counterpart of WorkflowCard.
// Same selection / pin / context-menu / inline-dialog behavior in one line.

import { useRouter } from "next/navigation"
import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import { MoreHorizontalIcon, PinIcon, WorkflowIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import type { WorkflowRow as WorkflowRowType } from "@/types/workflow/visual"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { WorkflowActionItems } from "./workflow-action-items"
import { WorkflowRenameDialog } from "./workflow-rename-dialog"
import { WorkflowEditTagsDialog } from "./workflow-edit-tags-dialog"
import { usePinnedWorkflows } from "./use-pinned-workflows"

export interface WorkflowRowProps {
  workflow: WorkflowRowType
}

function WorkflowRowImpl({ workflow }: WorkflowRowProps) {
  const t = useTranslations("workflows.card")
  const router = useRouter()
  const selectionMode = useWorkflowLibraryStore((s) => s.selectionMode)
  const selected = useWorkflowLibraryStore((s) => s.selection.has(workflow.id))
  const toggleSelection = useWorkflowLibraryStore((s) => s.toggleSelection)
  const openDeleteDialog = useWorkflowLibraryStore((s) => s.openDeleteDialog)
  const { isPinned } = usePinnedWorkflows()
  const pinned = isPinned(workflow.id)
  const [renameOpen, setRenameOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)

  const activate = () => {
    if (selectionMode) toggleSelection(workflow.id)
    else router.push(`/workflows/editor?id=${encodeURIComponent(workflow.id)}`)
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Card
            data-testid={`workflow-row-${workflow.id}`}
            data-workflow-id={workflow.id}
            data-selected={selected}
            className={cn(
              "group flex flex-row items-center gap-3 p-3 shadow-none transition hover:border-primary/50",
              selected && "border-primary ring-1 ring-primary"
            )}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={() => toggleSelection(workflow.id)}
              onClick={(e) => e.stopPropagation()}
              aria-label={t("select")}
              data-testid={`workflow-select-${workflow.id}`}
            />
            <button
              type="button"
              onClick={activate}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              data-testid={`workflow-open-${workflow.id}`}
            >
              <span className="shrink-0 rounded-md bg-primary/10 p-1.5 text-primary">
                <WorkflowIcon className="size-4" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
                {pinned ? (
                  <PinIcon
                    className="size-3.5 shrink-0 text-amber-500"
                    aria-label={t("pinned")}
                    data-testid={`workflow-pinned-${workflow.id}`}
                  />
                ) : null}
                <span className="truncate text-sm font-medium">{workflow.name}</span>
              </span>
              <span className="ml-2 hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {t("node", { count: workflow.nodes.length })}
              </span>
            </button>
            {workflow.isBuiltIn ? (
              <Badge variant="secondary" className="hidden font-normal sm:inline-flex">
                {t("builtin")}
              </Badge>
            ) : null}
            <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
              {t("updated", { ago: new Date(workflow.updatedAt).toLocaleDateString() })}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  aria-label={t("moreActions")}
                  data-testid={`workflow-row-menu-${workflow.id}`}
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <WorkflowActionItems
                  workflow={workflow}
                  Item={DropdownMenuItem}
                  Separator={DropdownMenuSeparator}
                  onRename={() => setRenameOpen(true)}
                  onEditTags={() => setTagsOpen(true)}
                  onDelete={() => openDeleteDialog([workflow.id])}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </Card>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <WorkflowActionItems
            workflow={workflow}
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
            onRename={() => setRenameOpen(true)}
            onEditTags={() => setTagsOpen(true)}
            onDelete={() => openDeleteDialog([workflow.id])}
          />
        </ContextMenuContent>
      </ContextMenu>
      <WorkflowRenameDialog workflow={workflow} open={renameOpen} onOpenChange={setRenameOpen} />
      <WorkflowEditTagsDialog workflow={workflow} open={tagsOpen} onOpenChange={setTagsOpen} />
    </>
  )
}

export const WorkflowRow = memo(WorkflowRowImpl)

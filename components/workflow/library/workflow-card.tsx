"use client"

import { useRouter } from "next/navigation"
import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import { MoreHorizontalIcon, PinIcon, WorkflowIcon } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import type { RunStatus, WorkflowRow } from "@/types/workflow/visual"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { WorkflowActionItems } from "./workflow-action-items"
import { WorkflowRenameDialog } from "./workflow-rename-dialog"
import { WorkflowEditTagsDialog } from "./workflow-edit-tags-dialog"
import { usePinnedWorkflows } from "./use-pinned-workflows"
import { RunStatusPill } from "@/components/workflow/runs/run-status-pill"

export interface WorkflowCardProps {
  workflow: WorkflowRow
  /** Total run count for the run-history badge (omitted/0 → hidden). */
  runCount?: number
  /** Status of the most recent run for the "last run" badge. */
  lastStatus?: RunStatus
}

function WorkflowCardImpl({ workflow, runCount, lastStatus }: WorkflowCardProps) {
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

  const triggerCount = workflow.nodes.filter((n) => n.type.startsWith("trigger.")).length
  const actionCount = workflow.nodes.filter((n) => n.type.startsWith("action.")).length
  const showCheckbox = selectionMode || selected

  const activate = () => {
    if (selectionMode) toggleSelection(workflow.id)
    else router.push(`/workflows/editor?id=${encodeURIComponent(workflow.id)}`)
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Card
            data-testid={`workflow-card-${workflow.id}`}
            data-workflow-id={workflow.id}
            data-selected={selected}
            onClick={activate}
            className={cn(
              "group relative cursor-pointer transition hover:border-primary/50 hover:shadow-sm",
              selected && "border-primary ring-1 ring-primary"
            )}
          >
            <div
              className={cn(
                "absolute left-3 top-3 z-10 transition-opacity",
                !showCheckbox && "opacity-0 group-hover:opacity-100"
              )}
            >
              <Checkbox
                checked={selected}
                onCheckedChange={() => toggleSelection(workflow.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={t("select")}
                data-testid={`workflow-select-${workflow.id}`}
              />
            </div>
            <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3 pl-10">
              <button
                type="button"
                onClick={(e) => {
                  // The whole card already activates; stop the bubble so the
                  // keyboard-focusable title button doesn't fire activate twice.
                  e.stopPropagation()
                  activate()
                }}
                className="flex min-w-0 flex-1 items-start gap-3 text-left"
                data-testid={`workflow-open-${workflow.id}`}
              >
                <span className="shrink-0 rounded-md bg-primary/10 p-2 text-primary">
                  <WorkflowIcon className="size-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <CardTitle className="flex items-center gap-1.5 truncate text-base">
                    {pinned ? (
                      <PinIcon
                        className="size-3.5 shrink-0 text-amber-500"
                        aria-label={t("pinned")}
                        data-testid={`workflow-pinned-${workflow.id}`}
                      />
                    ) : null}
                    <span className="truncate">{workflow.name}</span>
                  </CardTitle>
                  {workflow.description ? (
                    <CardDescription className="mt-1 line-clamp-2">
                      {workflow.description}
                    </CardDescription>
                  ) : null}
                </div>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => e.stopPropagation()}
                    className="size-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={t("moreActions")}
                    data-testid={`workflow-card-menu-${workflow.id}`}
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
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2 pt-0 text-xs text-muted-foreground">
              <Badge variant="outline" className="font-normal">
                {t("node", { count: workflow.nodes.length })}
              </Badge>
              {triggerCount > 0 ? (
                <Badge variant="outline" className="font-normal">
                  {t("trigger", { count: triggerCount })}
                </Badge>
              ) : null}
              {actionCount > 0 ? (
                <Badge variant="outline" className="font-normal">
                  {t("action", { count: actionCount })}
                </Badge>
              ) : null}
              {workflow.isBuiltIn ? (
                <Badge variant="secondary" className="font-normal">
                  {t("builtin")}
                </Badge>
              ) : null}
              {workflow.isTemplate ? (
                <Badge variant="secondary" className="font-normal">
                  {t("template")}
                </Badge>
              ) : null}
              {workflow.tags?.map((tag) => (
                <Badge key={tag} variant="outline" className="font-normal">
                  {tag}
                </Badge>
              ))}
              {runCount && runCount > 0 ? (
                <Badge
                  variant="outline"
                  className="font-normal"
                  data-testid={`workflow-runcount-${workflow.id}`}
                >
                  {t("runCountBadge", { count: runCount })}
                </Badge>
              ) : null}
              {lastStatus ? (
                <RunStatusPill
                  status={lastStatus}
                  showIcon={false}
                  className="px-1.5 py-0 text-[10px]"
                />
              ) : null}
              <span className="ml-auto">
                {t("updated", { ago: new Date(workflow.updatedAt).toLocaleDateString() })}
              </span>
            </CardContent>
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

export const WorkflowCard = memo(WorkflowCardImpl)

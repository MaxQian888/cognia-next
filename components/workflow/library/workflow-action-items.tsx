"use client"

// Shared per-workflow action list, rendered into either a DropdownMenu or a
// right-click ContextMenu by passing the matching `Item` / `Separator`
// primitives. Keeping one source of truth means the ⋯ menu and the right-click
// menu never drift apart.

import type { ComponentType, MouseEvent, ReactNode } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import {
  CopyIcon,
  FolderInputIcon,
  LayoutTemplateIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  TagIcon,
  Trash2Icon,
} from "lucide-react"
import { duplicateWorkflow, saveWorkflowAsTemplate } from "@/lib/db/workflows"
import type { WorkflowRow } from "@/types/workflow/visual"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { usePinnedWorkflows } from "./use-pinned-workflows"

/** Minimal shape both DropdownMenuItem and ContextMenuItem satisfy. */
export type MenuItemComponent = ComponentType<{
  children: ReactNode
  asChild?: boolean
  disabled?: boolean
  className?: string
  onClick?: (e: MouseEvent) => void
  "data-testid"?: string
}>

export interface WorkflowActionItemsProps {
  workflow: WorkflowRow
  Item: MenuItemComponent
  Separator: ComponentType
  onRename: () => void
  onEditTags: () => void
  onDelete: () => void
}

export function WorkflowActionItems({
  workflow,
  Item,
  Separator,
  onRename,
  onEditTags,
  onDelete,
}: WorkflowActionItemsProps) {
  const t = useTranslations("workflows.card")
  const router = useRouter()
  const openMoveDialog = useWorkflowLibraryStore((s) => s.openMoveDialog)
  const { isPinned, togglePin } = usePinnedWorkflows()
  const pinned = isPinned(workflow.id)

  const handleDuplicate = async () => {
    try {
      const copy = await duplicateWorkflow(workflow.id)
      toast.success(t("duplicated"))
      router.push(`/workflows/editor?id=${encodeURIComponent(copy.id)}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("duplicateFailed"))
    }
  }

  const handleSaveAsTemplate = async () => {
    try {
      await saveWorkflowAsTemplate(workflow.id)
      toast.success(t("savedAsTemplate"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveAsTemplateFailed"))
    }
  }

  return (
    <>
      <Item asChild data-testid={`workflow-action-edit-${workflow.id}`}>
        <Link href={`/workflows/editor?id=${encodeURIComponent(workflow.id)}`}>
          <PencilIcon className="size-4 mr-2" /> {t("edit")}
        </Link>
      </Item>
      <Item asChild>
        <Link href={`/workflows/runs?id=${encodeURIComponent(workflow.id)}`}>
          <PlayIcon className="size-4 mr-2" /> {t("viewRuns")}
        </Link>
      </Item>
      <Item onClick={handleDuplicate}>
        <CopyIcon className="size-4 mr-2" /> {t("duplicate")}
      </Item>
      <Item
        onClick={handleSaveAsTemplate}
        data-testid={`workflow-action-save-template-${workflow.id}`}
      >
        <LayoutTemplateIcon className="size-4 mr-2" /> {t("saveAsTemplate")}
      </Item>
      <Separator />
      <Item
        onClick={() => openMoveDialog([workflow.id])}
        data-testid={`workflow-action-move-${workflow.id}`}
      >
        <FolderInputIcon className="size-4 mr-2" /> {t("moveTo")}
      </Item>
      <Item onClick={onRename} data-testid={`workflow-action-rename-${workflow.id}`}>
        <PencilIcon className="size-4 mr-2" /> {t("rename")}
      </Item>
      <Item onClick={onEditTags} data-testid={`workflow-action-tags-${workflow.id}`}>
        <TagIcon className="size-4 mr-2" /> {t("editTags")}
      </Item>
      <Item
        onClick={() => void togglePin(workflow.id)}
        data-testid={`workflow-action-pin-${workflow.id}`}
      >
        {pinned ? (
          <>
            <PinOffIcon className="size-4 mr-2" /> {t("unpin")}
          </>
        ) : (
          <>
            <PinIcon className="size-4 mr-2" /> {t("pin")}
          </>
        )}
      </Item>
      <Separator />
      <Item
        className="text-destructive focus:text-destructive"
        onClick={onDelete}
        disabled={workflow.isBuiltIn}
        data-testid={`workflow-action-delete-${workflow.id}`}
      >
        <Trash2Icon className="size-4 mr-2" /> {t("delete")}
      </Item>
    </>
  )
}

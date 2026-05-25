"use client"

// Shared ⋯ action menu + delete confirmation for a folder tile/row. Rename
// routes through the library store (the create/rename dialog host handles it);
// delete uses reparent mode so contents move up to the parent — never
// destroyed. Used by both the grid folder-card and the list folder-row.

import { useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { deleteFolder } from "@/lib/db/workflow-folders"
import type { WorkflowFolder } from "@/types/workflow/folder"
import { useWorkflowLibraryStore } from "@/stores/workflow"

export interface WorkflowFolderMenuProps {
  folder: WorkflowFolder
}

export function WorkflowFolderMenu({ folder }: WorkflowFolderMenuProps) {
  const t = useTranslations("workflows.library.folders")
  const openRenameFolder = useWorkflowLibraryStore((s) => s.openRenameFolder)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const handleDelete = async () => {
    try {
      await deleteFolder(folder.id, "reparent")
      toast.success(t("deleted"))
      setConfirmDelete(false)
    } catch {
      toast.error(t("delete"))
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t("rename")}
            data-testid={`workflow-folder-menu-${folder.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            onClick={() => openRenameFolder(folder.id, folder.name)}
            data-testid={`workflow-folder-rename-${folder.id}`}
          >
            <PencilIcon className="size-4 mr-2" /> {t("rename")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setConfirmDelete(true)}
            data-testid={`workflow-folder-delete-${folder.id}`}
          >
            <Trash2Icon className="size-4 mr-2" /> {t("delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirm.title", { name: folder.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteConfirm.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("deleteConfirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("deleteConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

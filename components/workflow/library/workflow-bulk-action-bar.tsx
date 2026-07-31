"use client"

// Sticky batch-action bar shown while one or more workflows are selected.
// Routes Move / Tag / Delete through the same store dialogs the per-item menu
// uses, passing the full selection.

import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { DownloadIcon, FolderInputIcon, TagIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getDb } from "@/lib/db/schema"
import { downloadWorkflowJson, downloadWorkflowsBundle } from "@/lib/workflow/editor/workflow-json"
import { useWorkflowLibraryStore } from "@/stores/workflow"

export function WorkflowBulkActionBar() {
  const t = useTranslations("workflows.library.bulk")
  const selectionSize = useWorkflowLibraryStore((s) => s.selection.size)
  const openMoveDialog = useWorkflowLibraryStore((s) => s.openMoveDialog)
  const openTagDialog = useWorkflowLibraryStore((s) => s.openTagDialog)
  const openDeleteDialog = useWorkflowLibraryStore((s) => s.openDeleteDialog)
  const clearSelection = useWorkflowLibraryStore((s) => s.clearSelection)

  if (selectionSize === 0) return null

  const ids = () => Array.from(useWorkflowLibraryStore.getState().selection)

  const handleExport = async () => {
    const rows = (await getDb().workflows.bulkGet(ids())).filter((w) => w !== undefined)
    if (rows.length === 0) return
    if (rows.length === 1) downloadWorkflowJson(rows[0])
    else downloadWorkflowsBundle(rows)
    toast.success(t("exported", { count: rows.length }))
  }

  return (
    <div
      className="flex items-center gap-2 border-b bg-muted/50 px-6 py-2"
      data-testid="workflow-bulk-bar"
    >
      <span className="text-sm font-medium" data-testid="workflow-bulk-count">
        {t("selected", { count: selectionSize })}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          data-testid="workflow-bulk-export"
        >
          <DownloadIcon className="size-3.5 sm:mr-1.5" />
          <span className="hidden sm:inline">{t("export")}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openMoveDialog(ids())}
          data-testid="workflow-bulk-move"
        >
          <FolderInputIcon className="size-3.5 sm:mr-1.5" />
          <span className="hidden sm:inline">{t("move")}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openTagDialog(ids())}
          data-testid="workflow-bulk-tag"
        >
          <TagIcon className="size-3.5 sm:mr-1.5" />
          <span className="hidden sm:inline">{t("tag")}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => openDeleteDialog(ids())}
          data-testid="workflow-bulk-delete"
        >
          <Trash2Icon className="size-3.5 sm:mr-1.5" />
          <span className="hidden sm:inline">{t("delete")}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => clearSelection()}
          data-testid="workflow-bulk-clear"
        >
          <XIcon className="size-3.5 sm:mr-1.5" />
          <span className="hidden sm:inline">{t("clear")}</span>
        </Button>
      </div>
    </div>
  )
}

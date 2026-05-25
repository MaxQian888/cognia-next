"use client"

// Single + bulk workflow delete confirmation, driven by the store's
// `deleteDialogTarget`. Built-in workflows are protected: they're filtered out
// of the delete set and reported as skipped.

import { useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
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
import { deleteWorkflow, getWorkflow } from "@/lib/db/workflows"
import { useWorkflowLibraryStore } from "@/stores/workflow"

export function WorkflowDeleteDialog() {
  const t = useTranslations("workflows.library.bulk")
  const target = useWorkflowLibraryStore((s) => s.deleteDialogTarget)
  const close = useWorkflowLibraryStore((s) => s.closeDeleteDialog)
  const clearSelection = useWorkflowLibraryStore((s) => s.clearSelection)
  const [busy, setBusy] = useState(false)
  const ids = target?.ids ?? []

  const handleDelete = async () => {
    if (busy) return
    setBusy(true)
    try {
      const rows = await Promise.all(ids.map((id) => getWorkflow(id)))
      const deletable = rows.filter((r): r is NonNullable<typeof r> => !!r && !r.isBuiltIn)
      const skipped = rows.filter((r) => r?.isBuiltIn).length
      await Promise.all(deletable.map((r) => deleteWorkflow(r.id)))
      if (deletable.length > 0) toast.success(t("deleted", { count: deletable.length }))
      if (skipped > 0) toast.message(t("builtinSkipped", { count: skipped }))
      close()
      clearSelection()
    } catch {
      toast.error(t("deleteFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteConfirm.title", { count: ids.length })}</AlertDialogTitle>
          <AlertDialogDescription>{t("deleteConfirm.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("deleteConfirm.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              void handleDelete()
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="workflow-delete-confirm"
          >
            {t("deleteConfirm.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

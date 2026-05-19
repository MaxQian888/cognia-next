"use client"

import { useTranslations } from "next-intl"
import { toast } from "sonner"

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
import { deleteWorkflow } from "@/lib/db/workflows"
import type { WorkflowRow } from "@/types/workflow/visual"

export interface WorkflowDeleteConfirmProps {
  workflow: WorkflowRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Destructive-action confirm dialog for workflow deletion (Wave 4 / ADR-0026).
 *
 * Local Dexie delete fires immediately so the row disappears from the list;
 * the desktop is informed via the outbound queue so the canonical store is
 * kept in sync once connectivity returns.
 */
export function WorkflowDeleteConfirm({
  workflow,
  open,
  onOpenChange,
}: WorkflowDeleteConfirmProps) {
  const t = useTranslations("mobile.workflowList.deleteConfirm")

  async function handleConfirm() {
    if (!workflow) return
    try {
      // Wave 4 / ADR-0026 — local Dexie delete only. The desktop is the
      // canonical source; if the workflow still exists upstream, the next
      // `sync_pull` cursor re-emits the row. A server-side
      // `workflow_delete` RPC mirror is a Wave 5 follow-up (would need a
      // new entry in MOBILE_OUTBOUND_COMMANDS + Rust dispatcher).
      await deleteWorkflow(workflow.id)
      toast.success(t("toast", { name: workflow.name }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      onOpenChange(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="workflow-delete-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{workflow ? t("title", { name: workflow.name }) : ""}</AlertDialogTitle>
          <AlertDialogDescription>{t("body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="workflow-delete-cancel">{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void handleConfirm()}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="workflow-delete-confirm-button"
          >
            {t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

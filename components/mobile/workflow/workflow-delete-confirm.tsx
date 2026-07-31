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
import { enqueue } from "@/lib/db/mobile-outbound-queue"
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
      // Local Dexie delete fires immediately so the row leaves the list.
      await deleteWorkflow(workflow.id)
      // Mirror the deletion to the desktop's canonical store via the outbound
      // queue. Without this the next `sync_pull` cursor re-emits the row,
      // because the desktop never learned of the delete. `workflow_delete`
      // routes through the companion RPC bridge → desktop `deleteWorkflow`,
      // which records a tombstone that `sync_pull` then replays as a
      // `deleted_ids` entry. The command is control-gated; if this device
      // lacks remote-control capability the job deadletters through the
      // existing outbound-queue retry UX rather than silently losing the edit.
      await enqueue({
        command: "workflow_delete",
        payload: { id: workflow.id },
        label: t("queueLabel", { name: workflow.name }),
      })
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

"use client"

/**
 * Confirmation gate for discarding working-tree changes. Discarding is
 * irreversible (unlike unstage), so — matching VSCode's default — the panel
 * asks before throwing edits away. Shared by the per-file / group discard in
 * `changes-view` and the "Discard All" item in `sync-toolbar`; whether it opens
 * at all is decided by the caller from `prefs.confirmDiscard`.
 */

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

interface DiscardConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  /** File name when discarding a single file; null/undefined for discard-all. */
  fileName?: string | null
}

export function DiscardConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  fileName,
}: DiscardConfirmDialogProps) {
  const t = useTranslations("sourceControl")
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="discard-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("discard.confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {fileName ? t("discard.confirmFile", { file: fileName }) : t("discard.confirmAll")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
            data-testid="discard-confirm-action"
          >
            {t("discard.confirmAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

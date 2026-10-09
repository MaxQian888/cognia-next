"use client"

/**
 * Confirmation before stopping a goal (ADR-0019).
 *
 * Stop is terminal: a stopped goal cannot be resumed, only re-run as a new
 * goal. History's delete already asked first while the far more common stop
 * did not, on the console card, the composer pill and the phone row alike.
 * Every stop now goes through this one dialog.
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

export interface GoalStopConfirmProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The objective being stopped, quoted so the user knows which goal. */
  objective: string
  onConfirm: () => void
}

export function GoalStopConfirm({
  open,
  onOpenChange,
  objective,
  onConfirm,
}: GoalStopConfirmProps) {
  const t = useTranslations("goal.stopConfirm")
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="goal-stop-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <p className="line-clamp-3 rounded-md bg-muted/50 px-3 py-2 text-sm">{objective}</p>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="goal-stop-cancel">{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={onConfirm}
            data-testid="goal-stop-confirm-action"
          >
            {t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

GoalStopConfirm.displayName = "GoalStopConfirm"

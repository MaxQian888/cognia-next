"use client"

/**
 * "Clean up old runs", asked first and answered after.
 *
 * The header's overflow item used to delete every run older than thirty days
 * on a single click, with no confirmation and no result: the user could not
 * tell whether it removed hundreds of runs, none, or failed. Run history is
 * the only record of what a schedule did, and deleting it cannot be undone.
 */

import { useState } from "react"
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

export interface CleanupRunsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  maxAgeDays: number
  /** Resolves to the number of runs removed; rejects when the clean-up failed. */
  onConfirm: () => Promise<number>
}

export function CleanupRunsDialog({
  open,
  onOpenChange,
  maxAgeDays,
  onConfirm,
}: CleanupRunsDialogProps) {
  const t = useTranslations("scheduler.cleanupRuns")
  const [working, setWorking] = useState(false)

  const confirm = async () => {
    setWorking(true)
    try {
      const removed = await onConfirm()
      if (removed > 0) toast.success(t("done", { count: removed }))
      else toast.info(t("nothing", { days: maxAgeDays }))
      onOpenChange(false)
    } catch (error) {
      toast.error(t("failed"), {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setWorking(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (working ? undefined : onOpenChange(next))}>
      <AlertDialogContent data-testid="cleanup-runs-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("description", { days: maxAgeDays })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={working}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={working}
            onClick={(event) => {
              // Keep the dialog up until the result is known.
              event.preventDefault()
              void confirm()
            }}
            data-testid="cleanup-runs-confirm"
          >
            {working ? t("working") : t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

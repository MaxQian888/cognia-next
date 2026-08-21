"use client"

/**
 * DeleteItemDialog — the single "are you sure" for every delete on the
 * scheduler page.
 *
 * Deleting used to be asymmetric: the detail pane asked first, but the hover
 * menu on every list row called the source adapter directly, so one mis-click
 * on a row silently destroyed a schedule. Both routes now open this dialog,
 * and unlike the old app-only copy ("this task") it names the item and its
 * source — the list mixes six kinds, and "which one am I deleting" is exactly
 * the question a confirmation exists to answer.
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
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

export interface DeleteItemDialogProps {
  /** The item awaiting confirmation; `null` keeps the dialog closed. */
  item: UnifiedScheduledItem | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function DeleteItemDialog({ item, onOpenChange, onConfirm }: DeleteItemDialogProps) {
  const t = useTranslations("scheduler")

  return (
    <AlertDialog open={item !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="scheduler-delete-item-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteTask")}</AlertDialogTitle>
          <AlertDialogDescription>
            {item
              ? t("deleteItemConfirm", {
                  name: item.name,
                  kind: t(`kindFilter.${item.kind}`),
                })
              : t("deleteTaskConfirm")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            data-testid="scheduler-delete-item-confirm"
            className="bg-destructive text-destructive-foreground"
          >
            {t("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

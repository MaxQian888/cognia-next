"use client"

/**
 * The one confirmation in front of every permanent memory delete on `/memory`
 * — a row's menu, the inspector, the bulk bar and "Clear filtered" all request
 * a delete and land here. The row menu used to delete with no confirmation at
 * all while the inspector and bulk bar each had their own.
 */

import { useTranslations } from "next-intl"

import { ConfirmActionDialog } from "@/components/agent/workspace/settings/confirm-action-dialog"

export interface MemoryDeleteConfirmProps {
  /** Ids waiting for confirmation; `null` keeps the dialog closed. */
  ids: readonly string[] | null
  onCancel: () => void
  onConfirm: () => void
}

export function MemoryDeleteConfirm({ ids, onCancel, onConfirm }: MemoryDeleteConfirmProps) {
  const t = useTranslations("memory.panel.deleteConfirm")
  const count = ids?.length ?? 0
  return (
    <ConfirmActionDialog
      open={ids !== null && count > 0}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
      title={t("title", { count })}
      description={t("description", { count })}
      confirmLabel={t("confirm")}
      cancelLabel={t("cancel")}
      tone="destructive"
      onConfirm={onConfirm}
    />
  )
}

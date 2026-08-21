"use client"

/**
 * Confirmation gate for deleting issues.
 *
 * `deleteIssue` cascades: the issue, its whole event trail, and its run
 * history all go, and none of it is recoverable from the UI. That is worth a
 * dialog that says so and names what is going, rather than a menu item that
 * fires on release.
 *
 * Handles one issue and a bulk selection through the same component so the two
 * paths cannot describe the same irreversible act differently.
 */

import { useTranslations } from "next-intl"
import { useState } from "react"

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
import type { UnifiedIssueItem } from "@/types/issues/unified"

export interface DeleteIssueDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The issues that would actually be deleted — already capability-filtered. */
  items: readonly UnifiedIssueItem[]
  onConfirm: () => Promise<void> | void
}

export function DeleteIssueDialog({
  open,
  onOpenChange,
  items,
  onConfirm,
}: DeleteIssueDialogProps) {
  const t = useTranslations("issues")
  const [busy, setBusy] = useState(false)

  const single = items.length === 1 ? items[0] : null

  async function confirm() {
    setBusy(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="issue-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {single
              ? t("delete.titleOne", { identifier: single.identifier })
              : t("delete.titleMany", { count: items.length })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {single ? t("delete.bodyOne", { title: single.title }) : t("delete.bodyMany")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="issue-delete-cancel">
            {t("delete.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || items.length === 0}
            onClick={(event) => {
              // Keep the dialog up until the cascade finishes, so a slow delete
              // cannot look like it silently did nothing.
              event.preventDefault()
              void confirm()
            }}
            data-testid="issue-delete-confirm"
          >
            {busy ? t("delete.working") : t("delete.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

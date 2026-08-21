"use client"

/**
 * Confirmation gate for deleting a delivery container.
 *
 * `deleteIssueProject` cascades: the container, every issue in it, and every
 * one of those issues' events and runs. That is the most destructive action in
 * the tracker and it had no UI at all. The dialog names the container and
 * states the issue count, because "delete project" without a number is a
 * decision made blind.
 */

import { useState } from "react"
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
import type { IssueProject } from "@/types/issues"

export interface DeleteProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: IssueProject | null
  /** How many issues go with it. */
  issueCount: number
  onConfirm: () => Promise<void> | void
}

export function DeleteProjectDialog({
  open,
  onOpenChange,
  project,
  issueCount,
  onConfirm,
}: DeleteProjectDialogProps) {
  const t = useTranslations("issues")
  const [busy, setBusy] = useState(false)

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
      <AlertDialogContent data-testid="delete-project-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("projects.deleteTitle", { name: project?.name ?? "" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("projects.deleteBody", { count: issueCount, key: project?.key ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="delete-project-cancel">
            {t("delete.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || !project}
            onClick={(event) => {
              // Keep the dialog up until the cascade finishes; a slow delete
              // must not look like a no-op.
              event.preventDefault()
              void confirm()
            }}
            data-testid="delete-project-confirm"
          >
            {busy ? t("delete.working") : t("delete.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

"use client"

/**
 * The confirmation in front of `deleteCanvasDocument`.
 *
 * Canvas used to have one destructive verb wearing two costumes: the tab
 * strip's X and the rail's X both called `deleteCanvasDocument`, so "close this
 * tab" destroyed the document, its version history and its comments with no
 * prompt and no undo. Closing is now a layout operation
 * (`useCanvasLayoutStore.closeDocument`) and deleting goes through here.
 *
 * Both the rail and the panel toolbar render this, so the wording and the
 * consequences are stated once. It is controlled rather than trigger-owning
 * because both call sites raise it from a menu item that has already closed by
 * the time the dialog opens.
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

export interface CanvasDeleteDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Title of the document about to be destroyed, shown in the prompt. */
  documentTitle: string
  /** Number of saved versions that go with it, so the cost is visible. */
  versionCount?: number
  onConfirm: () => void
}

export function CanvasDeleteDocumentDialog({
  open,
  onOpenChange,
  documentTitle,
  versionCount = 0,
  onConfirm,
}: CanvasDeleteDocumentDialogProps) {
  const t = useTranslations("canvas")

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="canvas-delete-document-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteDocumentConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {versionCount > 0
              ? t("deleteDocumentConfirmWithVersions", {
                  name: documentTitle,
                  count: versionCount,
                })
              : t("deleteDocumentConfirm", { name: documentTitle })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            data-testid="canvas-delete-document-confirm"
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            {t("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

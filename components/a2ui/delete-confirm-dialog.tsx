"use client"

/**
 * Shared Delete Confirmation Dialog
 * Reusable across AppGallery, QuickAppBuilder, and other A2UI components
 * Uses AlertDialog for better accessibility with destructive confirmations
 */

import React, { memo, useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
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
import { buttonVariants } from "@/components/ui/button"
import type { DeleteConfirmDialogProps } from "@/types/a2ui/renderer"

export const DeleteConfirmDialog = memo(function DeleteConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  titleKey = "deleteConfirmTitle",
  descriptionKey = "deleteConfirmDescription",
}: DeleteConfirmDialogProps) {
  const t = useTranslations("a2ui")
  const [isConfirming, setIsConfirming] = useState(false)

  const handleConfirm = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      if (isConfirming) return
      setIsConfirming(true)
      try {
        await onConfirm()
        onOpenChange(false)
      } catch {
        // The owning editor reports the operation-specific error. Keeping the
        // controlled dialog open lets the user retry or cancel explicitly.
      } finally {
        setIsConfirming(false)
      }
    },
    [isConfirming, onConfirm, onOpenChange]
  )

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-[90vw] sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(titleKey)}</AlertDialogTitle>
          <AlertDialogDescription>{t(descriptionKey)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col sm:flex-row gap-2">
          <AlertDialogCancel
            className="w-full sm:w-auto touch-manipulation"
            disabled={isConfirming}
          >
            {t("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({
              variant: "destructive",
              className: "w-full sm:w-auto touch-manipulation",
            })}
            onClick={handleConfirm}
            disabled={isConfirming}
          >
            {isConfirming && <Loader2 className="h-4 w-4 animate-spin" />}
            {isConfirming ? t("deleting") : t("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
})

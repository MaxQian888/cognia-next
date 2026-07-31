"use client"

/**
 * Dialog wrapper for the add-source flow — used by the Sources tab. The
 * creation wizard embeds `AddSourceFlow` inline instead (a dialog inside a
 * dialog would trap focus).
 */

import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AddSourceFlow } from "./add-source-flow"

export interface TwinAddSourceDialogProps {
  twinId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful commit with the number of sources created. */
  onAdded?: (count: number) => void
}

export function TwinAddSourceDialog({
  twinId,
  open,
  onOpenChange,
  onAdded,
}: TwinAddSourceDialogProps) {
  const t = useTranslations("twin.addSource")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl gap-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {open ? <AddSourceFlow twinId={twinId} onAdded={onAdded} /> : null}
      </DialogContent>
    </Dialog>
  )
}

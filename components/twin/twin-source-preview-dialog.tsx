"use client"

/**
 * Source preview dialog — a thin Dialog wrapper around the shared
 * `SourceContentPreview` body (tables via `@cognia/document/table-extractor`
 * + capped text). The add-source flow's review step renders the same body
 * inline, so the two preview surfaces can't drift.
 */

import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SourceContentPreview } from "./source-content-preview"
import type { TwinSource } from "@/types/twin"

export interface TwinSourcePreviewDialogProps {
  source: TwinSource
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TwinSourcePreviewDialog({
  source,
  open,
  onOpenChange,
}: TwinSourcePreviewDialogProps) {
  const t = useTranslations("twin.sources")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl gap-4">
        <DialogHeader>
          <DialogTitle className="truncate">
            {t("previewTitle", { title: source.title })}
          </DialogTitle>
          <DialogDescription>{t("previewDescription")}</DialogDescription>
        </DialogHeader>
        <SourceContentPreview text={source.source} active={open} />
      </DialogContent>
    </Dialog>
  )
}

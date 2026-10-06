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
  source: Pick<TwinSource, "title" | "source">
  open: boolean
  onOpenChange: (open: boolean) => void
  location?: {
    charStart: number
    charEnd: number
    pageNumber?: number
    pageEnd?: number
    lineStart?: number
    lineEnd?: number
  }
  historicalVersion?: boolean
  textOffset?: number
}

export function TwinSourcePreviewDialog({
  source,
  open,
  onOpenChange,
  location,
  historicalVersion = false,
  textOffset,
}: TwinSourcePreviewDialogProps) {
  const t = useTranslations("twin.sources")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl gap-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="truncate">
            {t("previewTitle", { title: source.title })}
          </DialogTitle>
          <DialogDescription>{t("previewDescription")}</DialogDescription>
        </DialogHeader>
        {historicalVersion ? (
          <p role="status" className="text-sm text-amber-600">
            {t("historicalVersion")}
          </p>
        ) : null}
        {location ? (
          <p className="text-xs text-muted-foreground" data-testid="source-preview-location">
            {location.pageNumber !== undefined
              ? t("pageLocation", {
                  start: location.pageNumber,
                  end: location.pageEnd ?? location.pageNumber,
                })
              : location.lineStart !== undefined
                ? t("lineLocation", {
                    start: location.lineStart,
                    end: location.lineEnd ?? location.lineStart,
                  })
                : t("characterLocation", { start: location.charStart, end: location.charEnd })}
          </p>
        ) : null}
        <SourceContentPreview
          text={source.source}
          active={open}
          highlight={location}
          textOffset={textOffset}
        />
      </DialogContent>
    </Dialog>
  )
}

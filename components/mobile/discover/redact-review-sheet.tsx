"use client"

/**
 * Redact-review sheet for mobile twin ingest.
 *
 * The twin ingest pipeline already redacts PII server-side before any
 * LLM/embed call (`lib/twin/ingest/redact.ts` is the shared gate). This
 * sheet surfaces that gate on the phone *before* the text leaves the device:
 * when a text ingest path (paste / OCR) carries detectable PII, we show the
 * `redactText()` output and let the user ship the redacted version (default,
 * safe) or knowingly send the original. Pure w.r.t. its props so it unit
 * tests without Dexie or native plugins.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ShieldAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { redactText } from "@cognia/redact"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"

export interface RedactReviewSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The candidate text awaiting review. */
  text: string
  /** Enqueue the chosen text (redacted or original). The sheet closes after. */
  onConfirm: (chosen: string) => void | Promise<void>
}

export function RedactReviewSheet({ open, onOpenChange, text, onConfirm }: RedactReviewSheetProps) {
  const t = useTranslations("mobile.twinSources.redact")
  useBackDismiss(open, () => onOpenChange(false))
  const { redacted, count } = useMemo(() => {
    const result = redactText(text)
    return { redacted: result.redacted, count: Object.keys(result.map).length }
  }, [text])

  const choose = async (chosen: string) => {
    await onConfirm(chosen)
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" data-testid="twin-redact-review-sheet">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-amber-500" aria-hidden="true" />
            {t("title")}
          </SheetTitle>
          <SheetDescription className="flex items-center gap-2">
            <span>{t("description")}</span>
            <Badge variant="secondary" className="text-[10px]" data-testid="twin-redact-count">
              {count}
            </Badge>
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="mx-4 my-3 max-h-60 rounded-md border bg-muted/30">
          <pre
            className="whitespace-pre-wrap break-words p-3 text-xs"
            data-testid="twin-redact-preview"
          >
            {redacted}
          </pre>
        </ScrollArea>

        <SheetFooter className="flex-col gap-2">
          <Button onClick={() => void choose(redacted)} data-testid="twin-redact-send-redacted">
            {t("sendRedacted")}
          </Button>
          <Button
            variant="outline"
            onClick={() => void choose(text)}
            data-testid="twin-redact-send-original"
          >
            {t("sendOriginal")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="twin-redact-cancel"
          >
            {t("cancel")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

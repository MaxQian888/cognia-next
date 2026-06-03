"use client"

/**
 * Side sheet that displays per-page OCR Markdown.
 *
 * Rendered as a dialog rather than a permanent side panel so it doesn't
 * compete with the chat layout. Caller controls open state through the
 * `open` / `onOpenChange` props — the composer wires it to the result of
 * `useOcr().run(...)`.
 */

import { useTranslations } from "next-intl"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { OcrTextOverlay } from "./ocr-text-overlay"
import type { OcrResult } from "@/types/ocr"

export interface OcrResultBubbleProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  result: OcrResult | null
  onCopy?: (text: string) => Promise<void> | void
  onCopyPage?: (pageNumber: number, text: string) => Promise<void> | void
  /**
   * Source image for the Live-Text overlay (ADR-0024 Phase 2). When supplied
   * and the result is a single page with bbox'd blocks, the sheet shows the
   * image with selectable text positioned over it.
   */
  imageSrc?: string
}

export function OcrResultBubble(props: OcrResultBubbleProps): React.ReactElement {
  const t = useTranslations()
  const { result, onCopy, onCopyPage } = props
  // Live-Text overlay only makes sense for a single-image result whose blocks
  // carry bboxes (PDFs have no single source image to lay text over).
  const overlayPage =
    result?.document?.pages.length === 1 && result.document.pages[0]!.blocks.some((b) => b.bbox)
      ? result.document.pages[0]!
      : null
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="w-[min(640px,100vw)] sm:max-w-none">
        <SheetHeader>
          <SheetTitle>{t("ocr.composer.resultSheet.title")}</SheetTitle>
          {result?.providerId ? (
            <SheetDescription>
              {result.providerId} · {result.languages.join(", ") || "—"}
            </SheetDescription>
          ) : null}
        </SheetHeader>

        <ScrollArea className="my-4 max-h-[70vh] pr-2">
          {props.imageSrc && overlayPage ? (
            <div className="mb-6">
              <OcrTextOverlay imageSrc={props.imageSrc} page={overlayPage} />
            </div>
          ) : null}
          {result?.pages?.length ? (
            result.pages.map((page) => (
              <article key={page.pageNumber} className="mb-6">
                <header className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Page {page.pageNumber}</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void onCopyPage?.(page.pageNumber, page.text)}
                  >
                    {t("ocr.composer.resultSheet.copyPage")}
                  </Button>
                </header>
                <pre
                  className="mt-2 max-h-72 overflow-auto rounded bg-muted/40 p-3 text-xs whitespace-pre-wrap"
                  data-testid={`ocr-page-${page.pageNumber}`}
                >
                  {page.markdown || page.text}
                </pre>
              </article>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">{t("ocr.composer.resultSheet.empty")}</p>
          )}
        </ScrollArea>

        <SheetFooter>
          {result?.combinedMarkdown ? (
            <Button type="button" onClick={() => void onCopy?.(result.combinedMarkdown)}>
              {t("ocr.composer.resultSheet.copy")}
            </Button>
          ) : null}
          <SheetClose asChild>
            <Button type="button" variant="outline">
              {t("common.close")}
            </Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

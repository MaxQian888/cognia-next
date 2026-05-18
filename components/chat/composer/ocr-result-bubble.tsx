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
import type { OcrResult } from "@/lib/ocr/types"

export interface OcrResultBubbleProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  result: OcrResult | null
  onCopy?: (text: string) => Promise<void> | void
  onCopyPage?: (pageNumber: number, text: string) => Promise<void> | void
}

export function OcrResultBubble(props: OcrResultBubbleProps): React.ReactElement {
  const t = useTranslations()
  const { result, onCopy, onCopyPage } = props
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

"use client"

/**
 * Inline per-page OCR result renderer.
 *
 * Same per-page Markdown pre-block pattern as
 * `components/chat/composer/ocr-result-bubble.tsx`, lifted out of its Sheet
 * wrapper so the Try It tab and the Compare view can render results in-place
 * without opening a side drawer. The Sheet-based bubble keeps its current
 * shape so the composer flow is untouched.
 */

import * as React from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import type { OcrResult } from "@/types/ocr"
import { cn } from "@/lib/utils"

interface OcrResultInlineProps {
  result: OcrResult | null
  className?: string
  showCombinedCopy?: boolean
  onCopy?: (text: string) => Promise<void> | void
  onCopyPage?: (pageNumber: number, text: string) => Promise<void> | void
}

export function OcrResultInline({
  result,
  className,
  showCombinedCopy = true,
  onCopy,
  onCopyPage,
}: OcrResultInlineProps): React.ReactElement {
  const t = useTranslations()

  if (!result || result.pages.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)} data-testid="ocr-inline-empty">
        {t("ocr.tryIt.result.empty")}
      </p>
    )
  }

  return (
    <div className={cn("space-y-3", className)} data-testid="ocr-result-inline">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span data-testid="ocr-result-provider">{result.providerId}</span>
        <span aria-hidden>·</span>
        <span data-testid="ocr-result-duration">{formatDuration(result.durationMs)}</span>
        {result.cached && (
          <span
            className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600"
            data-testid="ocr-result-cached"
          >
            {t("ocr.tryIt.result.cached")}
          </span>
        )}
        {result.costEstimate && (
          <span data-testid="ocr-result-cost">
            ${result.costEstimate.amount.toFixed(4)} / {result.costEstimate.unit}
          </span>
        )}
      </div>

      {result.pages.map((page) => (
        <article key={page.pageNumber} className="rounded border">
          <header className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5">
            <h4 className="text-xs font-medium">
              {t("ocr.tryIt.result.pageHeader", { page: page.pageNumber })}
              {page.fromTextLayer && (
                <span className="ml-2 text-[10px] text-muted-foreground">
                  {t("ocr.tryIt.result.fromTextLayer")}
                </span>
              )}
            </h4>
            {onCopyPage && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => void onCopyPage(page.pageNumber, page.text)}
                data-testid={`ocr-copy-page-${page.pageNumber}`}
              >
                {t("ocr.tryIt.result.copyPage")}
              </Button>
            )}
          </header>
          <pre
            className="max-h-72 overflow-auto p-3 text-xs whitespace-pre-wrap"
            data-testid={`ocr-page-${page.pageNumber}`}
          >
            {page.markdown || page.text}
          </pre>
        </article>
      ))}

      {showCombinedCopy && onCopy && result.combinedMarkdown && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void onCopy(result.combinedMarkdown)}
          data-testid="ocr-copy-combined"
        >
          {t("ocr.tryIt.result.copyAll")}
        </Button>
      )}
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "—"
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

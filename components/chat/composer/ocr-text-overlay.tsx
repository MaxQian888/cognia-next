"use client"

/**
 * Live-Text-style selectable overlay (ADR-0024 Phase 2 / 2b).
 *
 * Renders the source page image with transparent, user-selectable text spans
 * positioned over each block's bbox (Apple Live Text / PowerToys Text Extractor
 * pattern). Spans are sized as percentages of the page's natural dimensions and
 * the container holds the page aspect-ratio, so they track the rendered image
 * at any width. Clicking a span reports its citation id — the same id
 * `resolveCitation` maps back to, enabling click-to-highlight from an answer.
 */

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { OcrDocumentPage } from "@/types/ocr"

export interface OcrTextOverlayProps {
  imageSrc: string
  page: OcrDocumentPage
  /** Block id to render highlighted (e.g. the resolved citation target). */
  highlightedId?: string | null
  /** Fired with the block's citation id when a region is clicked. */
  onBlockClick?: (id: string) => void
  className?: string
}

function pageDimensions(page: OcrDocumentPage): { width: number; height: number } {
  if (page.width && page.height) return { width: page.width, height: page.height }
  let width = page.width ?? 0
  let height = page.height ?? 0
  for (const block of page.blocks) {
    if (!block.bbox) continue
    width = Math.max(width, block.bbox.x + block.bbox.width)
    height = Math.max(height, block.bbox.y + block.bbox.height)
  }
  return { width, height }
}

export function OcrTextOverlay({
  imageSrc,
  page,
  highlightedId,
  onBlockClick,
  className,
}: OcrTextOverlayProps): React.ReactElement {
  const t = useTranslations("ocr.overlay")
  const { width, height } = pageDimensions(page)
  const positioned = width > 0 && height > 0

  return (
    <div
      className={cn("relative w-full overflow-hidden rounded-md border bg-muted/30", className)}
      style={positioned ? { aspectRatio: `${width} / ${height}` } : undefined}
      aria-label={t("ariaLabel")}
      data-testid="ocr-text-overlay"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageSrc}
        alt={t("imageAlt")}
        className="absolute inset-0 h-full w-full object-contain"
      />
      {positioned &&
        page.blocks.map((block) => {
          if (!block.bbox) return null
          return (
            <span
              key={block.id}
              role="button"
              tabIndex={0}
              data-block-id={block.id}
              title={block.text}
              onClick={() => onBlockClick?.(block.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onBlockClick?.(block.id)
                }
              }}
              className={cn(
                "absolute cursor-text select-text overflow-hidden whitespace-pre-wrap text-[0px] leading-none text-transparent",
                "hover:bg-primary/10 focus:bg-primary/10 focus:outline-none",
                highlightedId === block.id && "bg-primary/25 ring-1 ring-primary"
              )}
              style={{
                left: `${(block.bbox.x / width) * 100}%`,
                top: `${(block.bbox.y / height) * 100}%`,
                width: `${(block.bbox.width / width) * 100}%`,
                height: `${(block.bbox.height / height) * 100}%`,
              }}
            >
              {block.text}
            </span>
          )
        })}
    </div>
  )
}

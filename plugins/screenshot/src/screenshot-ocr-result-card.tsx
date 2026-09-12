"use client"

/**
 * Rich chat card for `extract_screenshot_ocr` (ADR-0127). The tool returns a
 * plain object (`{ ok, text, markdown, providerId, blocks, … }`) which the
 * host's generic card would paint as a JSON wall — this card instead shows
 * the recognized text selectable + copyable, the provider that produced it,
 * and an "ask about this" action that appends the text to the composer.
 * Reuses the host's `chat.ocrResult` strings so it reads exactly like the
 * `/ocr` card. Returns `null` for error envelopes — a failure JSON is
 * clearer through the generic renderer.
 */

import { useTranslations } from "next-intl"
import { ScanTextIcon } from "lucide-react"

import { blockMediaSrc, type ToolResultRendererProps } from "@cognia/plugin-sdk/api/tool-renderer"
import { dispatchComposerAppend } from "@cognia/plugin-sdk/api/message-renderer"
import { Badge, Button, parseToolOutput, PluginImage, ToolCard, useCopy } from "@cognia/plugin-ui"
import { screenshotBlocks, type ContentBlockLike } from "./screenshot-result-card"

/** The fields of `performCaptureOcr`'s success envelope this card renders. */
interface ScreenshotOcrOutput {
  ok?: boolean
  text?: string
  providerId?: string
}

/**
 * The tool has two wire shapes: the plain success envelope (`{ ok, text, … }`)
 * and — when `includeImage` is set — MCP content blocks carrying the same
 * envelope as a JSON text block plus the frame as an image block. Resolve
 * both to `{ envelope, imageSrc }`; `null` envelope means "let the generic
 * card have it" (errors stay clearer as JSON anyway).
 */
function readScreenshotOcrPart(part: unknown): {
  envelope: ScreenshotOcrOutput | null
  imageSrc: string | null
} {
  const blocks = screenshotBlocks(part)
  if (blocks.length > 0) {
    const image = blocks.find((b) => (b as ContentBlockLike).type === "image")
    const textBlock = blocks.find((b) => (b as ContentBlockLike).type === "text")
    const raw = (textBlock as ContentBlockLike | undefined)?.text
    let envelope: ScreenshotOcrOutput | null = null
    if (typeof raw === "string") {
      try {
        envelope = JSON.parse(raw) as ScreenshotOcrOutput
      } catch {
        envelope = null
      }
    }
    return { envelope, imageSrc: image ? blockMediaSrc(image, "image/png") : null }
  }
  const output = parseToolOutput(
    (part as { output?: unknown }).output
  ) as ScreenshotOcrOutput | null
  return { envelope: output, imageSrc: null }
}

export function ScreenshotOcrResultCard({ part }: ToolResultRendererProps) {
  const t = useTranslations("chat.ocrResult")
  const { copied, copy } = useCopy({ scope: "screenshot-ocr" })
  const { envelope: output, imageSrc } = readScreenshotOcrPart(part)
  if (!output || output.ok !== true || typeof output.text !== "string") return null
  const text = output.text
  const hasText = text.trim().length > 0

  return (
    <ToolCard title={t("title")} testId="screenshot-ocr-result-card">
      <div className="flex items-start gap-2">
        <ScanTextIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1.5">
          {imageSrc ? (
            <div className="max-w-md">
              <PluginImage src={imageSrc} alt={t("thumbnailAlt")} />
            </div>
          ) : null}
          {hasText ? (
            <div
              className="max-h-60 select-text overflow-auto whitespace-pre-wrap rounded bg-background/60 p-2 text-xs"
              data-testid="screenshot-ocr-text"
            >
              {text}
            </div>
          ) : (
            <p className="text-xs italic text-muted-foreground">{t("noText")}</p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            {output.providerId ? (
              <Badge variant="outline">{t("provider", { id: output.providerId })}</Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              data-testid="screenshot-ocr-copy"
              disabled={!hasText}
              onClick={() => void copy(text)}
            >
              {copied ? t("copied") : t("copy")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              data-testid="screenshot-ocr-ask"
              disabled={!hasText}
              onClick={() => dispatchComposerAppend({ text })}
            >
              {t("askAbout")}
            </Button>
          </div>
        </div>
      </div>
    </ToolCard>
  )
}

export default ScreenshotOcrResultCard

"use client"

// gap4 — chat renderer for the `ocr-result` message part produced by `/ocr`.
// Shows the source thumbnail when it is displayable in-card, the recognized
// text (selectable + copyable), provider/language/confidence/cached/duration
// badges, and an "ask about this" action that appends the text to the composer.
//
// Strings come from the plugin's own `manifest.i18n` bundle
// (`usePluginTranslations`). Thumbnails: a `data-url` source renders directly.
// A `file-path` source has no plugin-reachable way to become an image URL (the
// host exposes no file-src API to plugin components), so it renders without a
// thumbnail rather than reaching into the Tauri runtime itself.

import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { Badge, Button, PluginImage, useCopy } from "@cognia/plugin-ui"
import {
  dispatchComposerAppend,
  type MessagePartRendererProps,
} from "@cognia/plugin-sdk/api/message-renderer"
import { type OcrResultPart, type OcrSourceRef } from "@cognia/plugin-sdk/api/ocr-provider"

export const PLUGIN_ID = "cognia-ocr"

function isOcrResultPart(part: unknown): part is OcrResultPart {
  const p = part as { type?: unknown; text?: unknown }
  return (
    typeof part === "object" &&
    part !== null &&
    p.type === "ocr-result" &&
    typeof p.text === "string"
  )
}

/** A displayable thumbnail src for the source ref, or `null`. */
export function thumbnailSrc(sourceRef: OcrSourceRef | undefined): string | null {
  if (sourceRef?.kind !== "data-url") return null
  return sourceRef.value.startsWith("data:image/") ? sourceRef.value : null
}

export function OcrResultCard({ part }: MessagePartRendererProps) {
  // `part` is typed as the SDK's UIMessage part union; our custom `ocr-result`
  // shape isn't in it, so narrow via `unknown`.
  const ocr: OcrResultPart | null = isOcrResultPart(part) ? (part as OcrResultPart) : null
  const t = usePluginTranslations(PLUGIN_ID)
  const { copied, copy } = useCopy({ scope: "ocr" })

  if (!ocr) return null
  const thumbnail = thumbnailSrc(ocr.sourceRef)
  const hasText = ocr.text.trim().length > 0
  const confidencePct = ocr.confidence !== null ? Math.round(ocr.confidence * 100) : null

  return (
    <div
      className="not-prose my-1 w-full min-w-0 max-w-md space-y-2 rounded-xl border bg-muted/30 p-3"
      data-testid="ocr-result-card"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {t("card.title")}
      </div>

      {thumbnail ? (
        <PluginImage src={thumbnail} alt={t("card.thumbnailAlt")} title={t("card.thumbnailAlt")} />
      ) : null}

      {hasText ? (
        <div
          className="max-h-60 select-text overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-xs"
          data-testid="ocr-result-text"
        >
          {ocr.text}
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground">{t("card.noText")}</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <Badge variant="outline">{t("card.provider", { id: ocr.providerId })}</Badge>
        {ocr.languages.length > 0 ? (
          <Badge variant="outline">
            {t("card.languages", { langs: ocr.languages.join(", ") })}
          </Badge>
        ) : null}
        {confidencePct !== null ? (
          <Badge variant="outline">{t("card.confidence", { pct: confidencePct })}</Badge>
        ) : null}
        {ocr.cached ? <Badge variant="secondary">{t("card.cached")}</Badge> : null}
        <Badge variant="outline">{t("card.duration", { ms: ocr.durationMs })}</Badge>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 text-xs sm:h-7"
          data-testid="ocr-result-copy"
          disabled={!hasText}
          onClick={() => void copy(ocr.text)}
        >
          {copied ? t("card.copied") : t("card.copy")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 text-xs sm:h-7"
          data-testid="ocr-result-ask"
          disabled={!hasText}
          onClick={() => dispatchComposerAppend({ text: ocr.text })}
        >
          {t("card.askAbout")}
        </Button>
      </div>
    </div>
  )
}

export default OcrResultCard

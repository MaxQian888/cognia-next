"use client"

// gap4 — chat renderer for the `ocr-result` message part produced by `/ocr`.
// Shows a best-effort source thumbnail, the recognized text (selectable +
// copyable), provider/language/confidence/cached/duration badges, and an
// "ask about this" action that appends the text to the composer.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import type { MessagePartRendererProps } from "@/lib/plugin/api/message-part-renderers"
import type { OcrResultPart, OcrSourceRef } from "@/lib/slash-commands/actions/ocr"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ImageBlock } from "@/components/chat/renderers/image-block"
import { COMPOSER_APPEND_EVENT } from "@/components/chat/composer"
import { useCopy } from "@/hooks/ui/use-copy"
import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/platform/detect"

function isOcrResultPart(part: unknown): part is OcrResultPart {
  const p = part as { type?: unknown; text?: unknown }
  return (
    typeof part === "object" &&
    part !== null &&
    p.type === "ocr-result" &&
    typeof p.text === "string"
  )
}

/** Best-effort: resolve a displayable thumbnail src from the source ref. */
function useThumbnailSrc(sourceRef: OcrSourceRef | undefined): string | null {
  // Synchronous cases (data-url, no thumbnail) are derived during render so a
  // ref change reads correctly without a state reset inside the effect. The
  // effect only resolves the async Tauri file-path case.
  const directSrc = sourceRef?.kind === "data-url" ? sourceRef.value : null
  const needsTauriResolve = sourceRef?.kind === "file-path" && isTauri()
  const [resolved, setResolved] = useState<{ ref: OcrSourceRef; src: string | null } | null>(null)
  useEffect(() => {
    if (!needsTauriResolve || !sourceRef) return
    let cancelled = false
    import("@tauri-apps/api/core")
      .then(({ convertFileSrc }) => {
        if (!cancelled) setResolved({ ref: sourceRef, src: convertFileSrc(sourceRef.value) })
      })
      .catch(() => {
        if (!cancelled) setResolved({ ref: sourceRef, src: null })
      })
    return () => {
      cancelled = true
    }
  }, [needsTauriResolve, sourceRef])
  if (needsTauriResolve) {
    // attachment-id and non-Tauri file paths have no in-card resolver — the
    // card works fine without a thumbnail (directSrc stays null).
    return resolved && resolved.ref === sourceRef ? resolved.src : null
  }
  return directSrc
}

export function OcrResultCard({ part }: MessagePartRendererProps) {
  // `part` is typed as the SDK's UIMessage part union; our custom `ocr-result`
  // shape isn't in it, so narrow via `unknown`.
  const ocr: OcrResultPart | null = isOcrResultPart(part) ? (part as OcrResultPart) : null
  const t = useTranslations("chat.ocrResult")
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })
  const thumbnail = useThumbnailSrc(ocr?.sourceRef)

  if (!ocr) return null
  const confidencePct = ocr.confidence !== null ? Math.round(ocr.confidence * 100) : null

  return (
    <div
      className="not-prose my-1 w-full max-w-md space-y-2 rounded-xl border bg-muted/30 p-3"
      data-testid="ocr-result-card"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {t("title")}
      </div>

      {thumbnail ? (
        <ImageBlock src={thumbnail} alt={t("thumbnailAlt")} title={t("thumbnailAlt")} />
      ) : null}

      {ocr.text.trim().length > 0 ? (
        <div
          className="max-h-60 select-text overflow-auto whitespace-pre-wrap rounded bg-background/60 p-2 text-xs"
          data-testid="ocr-result-text"
        >
          {ocr.text}
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground">{t("noText")}</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <Badge variant="outline">{t("provider", { id: ocr.providerId })}</Badge>
        {ocr.languages.length > 0 ? (
          <Badge variant="outline">{t("languages", { langs: ocr.languages.join(", ") })}</Badge>
        ) : null}
        {confidencePct !== null ? (
          <Badge variant="outline">{t("confidence", { pct: confidencePct })}</Badge>
        ) : null}
        {ocr.cached ? <Badge variant="secondary">{t("cached")}</Badge> : null}
        <Badge variant="outline">{t("duration", { ms: ocr.durationMs })}</Badge>
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          data-testid="ocr-result-copy"
          onClick={() => void copy(ocr.text)}
        >
          {copied ? t("copied") : t("copy")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          data-testid="ocr-result-ask"
          disabled={ocr.text.trim().length === 0}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent(COMPOSER_APPEND_EVENT, { detail: { text: ocr.text } })
            )
          }
        >
          {t("askAbout")}
        </Button>
      </div>
    </div>
  )
}

export default OcrResultCard

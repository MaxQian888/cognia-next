"use client"

// gap4 — chat renderer for the `ocr-result` message part produced by `/ocr`.
// Shows a best-effort source thumbnail, the recognized text (selectable +
// copyable), provider/language/confidence/cached/duration badges, and an
// "ask about this" action that appends the text to the composer.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Badge, Button, PluginImage, useCopy } from "@cognia/plugin-ui"
import { readHostCapabilities } from "@cognia/plugin-sdk/api/host-environment"
import {
  dispatchComposerAppend,
  type MessagePartRendererProps,
} from "@cognia/plugin-sdk/api/message-renderer"
import { type OcrResultPart, type OcrSourceRef } from "@cognia/plugin-sdk/api/ocr-provider"

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
  const needsTauriResolve = sourceRef?.kind === "file-path" && readHostCapabilities().tauri
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
  const { copied, copy } = useCopy({ scope: "ocr" })
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
        <PluginImage src={thumbnail} alt={t("thumbnailAlt")} title={t("thumbnailAlt")} />
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
          onClick={() => dispatchComposerAppend({ text: ocr.text })}
        >
          {t("askAbout")}
        </Button>
      </div>
    </div>
  )
}

export default OcrResultCard

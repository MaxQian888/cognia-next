"use client"

/**
 * Centered dialog that answers "what will the model actually get from this
 * file?". Reached directly for non-image attachments (click a file/video tile)
 * and as the audit surface for images (the lightbox's "Model view" action) —
 * images themselves view full-screen in `ImageLightbox`.
 *
 * Two layers, because they are genuinely different things in this app:
 *   - **File**  — the document as a human reads it. Delegates to the existing
 *     `FilePartPreview` (PDF `<object>` / syntax-highlighted code / download
 *     link), which until now only ran for inbound connector messages and never
 *     for the user's own staged attachments.
 *   - **Model** — the payload. Documents are flattened to text by
 *     `lib/chat/attachments/dispatch`, images are downscaled to
 *     `IMAGE_MAX_LONG_EDGE`, and both are run through the PII gate. None of
 *     that was visible before sending; this tab is the audit surface for it.
 *     A video or animated GIF is sampled instead, so its model tab is also
 *     where the sampling is chosen (`VideoPreprocessPanel`).
 */

import { useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ImageIcon, Loader2Icon, Maximize2Icon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AttachmentEmpty } from "@/components/ai-elements/attachments"
import { FilePartPreview } from "@/components/chat/message-parts/file-part-preview"
import { ImageLightbox } from "@/components/chat/renderers/image-lightbox"
import { IMAGE_MAX_LONG_EDGE } from "@/lib/chat/attachments/dispatch"
import { isVideoDescriptor } from "@/lib/chat/attachments/video/classify"
import type { NativeVideoVerdict } from "@/lib/chat/attachments/video/delivery-gate"
import type { VideoPreprocessSettings } from "@/lib/chat/attachments/video/settings"
import { countRedactions, splitRedactionSpans } from "@/lib/chat/attachments/redaction-spans"
import { formatBytesCompact } from "@/lib/observability/format-utils"
import type { StagedAttachmentState } from "./staged-attachment-store"
import { VideoPreprocessPanel } from "./video-preprocess-panel"
import { ModelSelect, type ModelSelectChoice } from "@/components/shared/model-select"
import type { AttachmentMediaOptions } from "@/lib/chat/attachments/media-extraction"

export interface PreviewTarget {
  id: string
  url?: string
  filename?: string
  mediaType?: string
}

export interface AttachmentPreviewDialogProps {
  onProcessMedia?: (
    id: string,
    options: Pick<AttachmentMediaOptions, "method" | "providerId" | "modelId">
  ) => void
  onCancelProcessing?: (id: string) => void
  onRetry?: (id: string) => void
  open: boolean
  onOpenChange: (next: boolean) => void
  /** The chip that was clicked. Null renders an inert dialog. */
  target: PreviewTarget | null
  /**
   * Which tab the dialog opens on. "file" for direct tile clicks; "model" when
   * the lightbox's Model view action drops the user straight into the audit.
   */
  initialTab?: "file" | "model"
  state?: StagedAttachmentState
  /** Runs OCR over an image attachment and stores the text on the staged entry. */
  onRunOcr?: (attachmentId: string) => void | Promise<void>
  ocrBusy?: boolean
  /** Opens the richer per-page OCR sheet. Absent until a result exists. */
  onViewOcrDetail?: () => void
  /** Appends the OCR text to the draft instead of attaching it to the payload. */
  onExtractOcrToInput?: (attachmentId: string) => void | Promise<void>
  onToggleIncludeOcr?: (attachmentId: string) => void
  /** Whether this conversation could take an original video file. */
  videoRoute: NativeVideoVerdict
  /** Re-samples a staged video or animated GIF with new settings. */
  onApplyVideoSettings: (attachmentId: string, settings: VideoPreprocessSettings) => void
}

/** Renders extracted text with the PII gate's substitutions marked. */
function RedactedText({ text }: { text: string }) {
  const spans = useMemo(() => splitRedactionSpans(text), [text])
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
      {spans.map((span, i) =>
        span.redacted ? (
          <mark
            key={i}
            data-testid="redacted-span"
            className="rounded bg-amber-200/70 px-0.5 text-amber-950 dark:bg-amber-500/30 dark:text-amber-100"
          >
            {span.text}
          </mark>
        ) : (
          <span key={i}>{span.text}</span>
        )
      )}
    </pre>
  )
}

export function AttachmentPreviewDialog(props: AttachmentPreviewDialogProps) {
  const t = useTranslations("chat.composer.attachments")
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [processingModel, setProcessingModel] = useState<ModelSelectChoice>({
    providerId: "",
    modelId: "",
  })
  // Wired to the real setter rather than a no-op: the panel shows one image
  // today, but nothing here assumes that.
  const [lightboxIndex, setLightboxIndex] = useState(0)
  const lightboxTriggerRef = useRef<HTMLElement | null>(null)

  const { target, state } = props
  const isImage = (target?.mediaType ?? "").startsWith("image/")
  const descriptor = { name: target?.filename ?? "", mediaType: target?.mediaType ?? "" }
  const isVideo = isVideoDescriptor(descriptor)
  // A GIF is a motion attachment once the pipeline has claimed it; a still GIF
  // (or any GIF in a conversation with the pipeline off) stays a picture.
  const isMotion = isVideo || state?.video !== undefined
  const isAudio =
    state?.extracted?.kind === "audio" || (target?.mediaType ?? "").startsWith("audio/")
  const extracted = state?.extracted
  const modelText = extracted?.text
  const redactionCount = modelText ? countRedactions(modelText) : 0
  // The downscaled bytes the wire carries — NOT the on-disk size, which is what
  // makes this worth showing separately from the chip's size hint.
  const modelBytes = extracted?.image?.bytes

  const lightboxItems = useMemo(() => {
    if (!target?.url || !isImage) return []
    return [
      {
        id: target.id,
        src: target.url,
        alt: target.filename ?? t("fallbackName"),
        filename: target.filename,
      },
    ]
  }, [target, isImage, t])

  const displayName = target?.filename ?? t("fallbackName")

  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className="max-h-[85dvh] w-[min(94vw,760px)] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="truncate">{displayName}</DialogTitle>
            <DialogDescription>
              {[
                target?.mediaType || null,
                state?.sizeBytes ? formatBytesCompact(state.sizeBytes) : null,
                extracted?.tokens ? t("preview.tokens", { tokens: extracted.tokens }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </DialogDescription>
          </DialogHeader>

          <Tabs
            key={target?.id ?? "none"}
            defaultValue={props.initialTab ?? "file"}
            className="mt-4"
          >
            <TabsList>
              <TabsTrigger value="file">{t("preview.fileTab")}</TabsTrigger>
              <TabsTrigger value="model">{t("preview.modelTab")}</TabsTrigger>
            </TabsList>

            {/* ── The file as a human reads it ─────────────────────────── */}
            <TabsContent value="file">
              <ScrollArea className="max-h-[65vh] pr-2">
                {!target?.url ? (
                  <AttachmentEmpty>{t("preview.empty")}</AttachmentEmpty>
                ) : isVideo ? (
                  // The source plays from its blob URL; it never becomes a data URL.
                  <video
                    src={target.url}
                    controls
                    preload="metadata"
                    aria-label={t("video.playerLabel", { filename: displayName })}
                    className="max-h-[50vh] w-full rounded-md border bg-black object-contain"
                  />
                ) : isAudio ? (
                  <audio
                    src={target.url}
                    controls
                    preload="metadata"
                    aria-label={t("processing.audioPlayer", { filename: displayName })}
                    className="w-full"
                  />
                ) : isImage ? (
                  <div className="space-y-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={target.url}
                      alt={displayName}
                      className="max-h-[50vh] w-auto rounded-md border object-contain"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        lightboxTriggerRef.current = e.currentTarget
                        setLightboxOpen(true)
                      }}
                    >
                      <Maximize2Icon className="size-3.5" />
                      {t("preview.fullSize")}
                    </Button>
                  </div>
                ) : (
                  <FilePartPreview
                    url={target.url}
                    mediaType={target.mediaType}
                    filename={target.filename}
                  />
                )}
              </ScrollArea>
            </TabsContent>

            {/* ── The payload the model receives ───────────────────────── */}
            <TabsContent value="model">
              <p className="mb-2 text-xs text-muted-foreground">{t("preview.modelHint")}</p>
              {(isImage || isMotion || isAudio) && props.onProcessMedia && target ? (
                <div className="mb-3 space-y-2 rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">{t("processing.modelHint")}</p>
                  <ModelSelect
                    model={processingModel.modelId}
                    provider={processingModel.providerId}
                    onSelect={setProcessingModel}
                    disabled={state?.status === "extracting"}
                  />
                  <p className="text-xs text-muted-foreground">{t("processing.cloudNotice")}</p>
                  <div className="flex flex-wrap gap-2">
                    {isAudio || isMotion ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          state?.status === "extracting" ||
                          !processingModel.modelId ||
                          !processingModel.providerId
                        }
                        onClick={() =>
                          props.onProcessMedia?.(target.id, {
                            ...processingModel,
                            method: "transcribe",
                          })
                        }
                      >
                        {t("processing.transcribe")}
                      </Button>
                    ) : null}
                    {isImage || isMotion ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          state?.status === "extracting" ||
                          !processingModel.modelId ||
                          !processingModel.providerId
                        }
                        onClick={() =>
                          props.onProcessMedia?.(target.id, {
                            ...processingModel,
                            method: "describe",
                          })
                        }
                      >
                        {t("processing.describe")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {state?.status === "extracting" && target ? (
                <div className="mb-2 flex items-center gap-2 text-xs" role="status">
                  {state.processing
                    ? t("processing.progress", state.processing)
                    : !isMotion
                      ? isImage
                        ? t("analyzing")
                        : t("extracting")
                      : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => props.onCancelProcessing?.(target.id)}
                  >
                    {t("processing.cancel")}
                  </Button>
                </div>
              ) : null}
              {state?.processingError ||
              state?.extracted?.extractedContent?.status === "failed" ||
              state?.status === "rejected" ? (
                <div className="mb-2 flex items-center gap-2 text-xs" role="alert">
                  {t(
                    isAudio && state.extracted?.rejectReason === "audio-unprocessed"
                      ? "processing.audioRequired"
                      : "processing.failed"
                  )}
                  {target && !isAudio ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => props.onRetry?.(target.id)}
                    >
                      {t("processing.retry")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {state?.extracted?.extractedContent?.status === "partial" ? (
                <p className="mb-2 text-xs text-amber-600">{t("processing.partial")}</p>
              ) : null}
              <ScrollArea className="max-h-[60vh] pr-2">
                {isMotion && target ? (
                  <VideoPreprocessPanel
                    filename={displayName}
                    state={state}
                    routeVerdict={props.videoRoute}
                    onApply={(settings) => props.onApplyVideoSettings(target.id, settings)}
                  />
                ) : state?.status === "extracting" ? null : isImage ? (
                  <div className="space-y-3">
                    {target?.url ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={target.url}
                          alt={displayName}
                          data-testid="model-view-image"
                          className="max-h-[40vh] w-auto rounded-md border object-contain"
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("preview.imageHint", { maxEdge: IMAGE_MAX_LONG_EDGE })}
                          {modelBytes ? ` · ${formatBytesCompact(modelBytes)}` : ""}
                        </p>
                      </>
                    ) : (
                      <AttachmentEmpty>{t("preview.empty")}</AttachmentEmpty>
                    )}

                    {/* OCR lives here, not on the chip: it is another layer of
                        "what the model sees", and showing the token cost next
                        to the toggle is the only way the user can weigh it. */}
                    <div className="rounded-md border p-3">
                      {state?.ocrText ? (
                        <>
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <Label htmlFor="ocr-include" className="text-xs">
                              {t("preview.ocrToggle")}
                            </Label>
                            <Switch
                              id="ocr-include"
                              checked={!!state.includeOcr}
                              onCheckedChange={() =>
                                target && props.onToggleIncludeOcr?.(target.id)
                              }
                            />
                          </div>
                          <RedactedText text={state.ocrText} />
                          <div className="mt-1 flex items-center gap-3">
                            {props.onViewOcrDetail ? (
                              <Button
                                type="button"
                                variant="link"
                                size="sm"
                                className="h-auto p-0 text-xs"
                                onClick={props.onViewOcrDetail}
                              >
                                {t("preview.ocrDetail")}
                              </Button>
                            ) : null}
                            {/* The old chip menu's second route, preserved: put
                                the text in the draft instead of the payload. */}
                            {props.onExtractOcrToInput ? (
                              <Button
                                type="button"
                                variant="link"
                                size="sm"
                                className="h-auto p-0 text-xs"
                                onClick={() =>
                                  target && void props.onExtractOcrToInput?.(target.id)
                                }
                              >
                                {t("preview.ocrToInput")}
                              </Button>
                            ) : null}
                          </div>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={props.ocrBusy || !target}
                          onClick={() => target && void props.onRunOcr?.(target.id)}
                        >
                          {props.ocrBusy ? (
                            <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                          ) : (
                            <ImageIcon className="size-3.5" aria-hidden />
                          )}
                          {props.ocrBusy ? t("preview.ocrRunning") : t("preview.ocrRun")}
                        </Button>
                      )}
                    </div>
                  </div>
                ) : modelText ? (
                  <div className="space-y-2">
                    {redactionCount > 0 ? (
                      <p
                        className="text-xs text-amber-600 dark:text-amber-500"
                        data-testid="redaction-note"
                      >
                        {t("preview.redactedNote")}
                      </p>
                    ) : null}
                    <RedactedText text={modelText} />
                  </div>
                ) : (
                  <AttachmentEmpty>{t("preview.empty")}</AttachmentEmpty>
                )}
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <ImageLightbox
        items={lightboxItems}
        open={lightboxOpen}
        activeIndex={lightboxIndex}
        returnFocusRef={lightboxTriggerRef}
        onActiveIndexChange={setLightboxIndex}
        onOpenChange={setLightboxOpen}
      />
    </>
  )
}

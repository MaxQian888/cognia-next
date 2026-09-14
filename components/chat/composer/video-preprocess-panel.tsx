"use client"

/**
 * The controls for one staged video or animated GIF, shown in the attachment
 * preview sheet's model view.
 *
 * Edits are held locally and only reach the store on Apply: every run seeks the
 * source (or shells out to ffmpeg), so re-sampling on each slider tick would
 * queue work nobody asked for. What the model will receive is always the LAST
 * APPLIED result, shown below the controls, and the Apply button says when the
 * controls no longer match it.
 *
 * Options a conversation cannot use are rendered disabled with the reason
 * spelled out, never hidden: "Original video" missing from the list would read
 * the same whether the model cannot take video, the file is too big, or this is
 * a team room.
 */

import { useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Slider as SliderPrimitive } from "radix-ui"
import { AlertTriangleIcon, Loader2Icon, RotateCcwIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Slider } from "@/components/ui/slider"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { formatBytesCompact } from "@/lib/observability/format-utils"
import type { NativeVideoVerdict } from "@/lib/chat/attachments/video/delivery-gate"
import { COMPOSER_VIDEO_SOURCE_MAX_BYTES } from "@/lib/chat/attachments/prepare"
import {
  DEFAULT_VIDEO_SETTINGS,
  VIDEO_FRAME_COUNT_BOUNDS,
  normalizeVideoSettings,
  sameVideoSettings,
  withVideoDelivery,
  type VideoDelivery,
  type VideoPreprocessSettings,
  type VideoSamplingStrategy,
} from "@/lib/chat/attachments/video/settings"
import {
  FRACTIONAL_TIMESTAMP_BELOW_SEC,
  formatVideoTimestamp,
} from "@/lib/chat/attachments/video/timeline"
import type { StagedAttachmentState } from "./staged-attachment-store"

export interface VideoPreprocessPanelProps {
  filename: string
  state: StagedAttachmentState | undefined
  /** The composer's native-video verdict for this conversation. */
  routeVerdict: NativeVideoVerdict
  onApply: (settings: VideoPreprocessSettings) => void
}

const DELIVERIES: readonly VideoDelivery[] = ["storyboard", "frames", "native"]
const STRATEGIES: readonly VideoSamplingStrategy[] = ["uniform", "scene"]

export function VideoPreprocessPanel({
  filename,
  state,
  routeVerdict,
  onApply,
}: VideoPreprocessPanelProps) {
  const t = useTranslations("chat.composer.attachments.video")
  const frameCountLabelId = useId()
  const video = state?.video
  const result = video?.result
  const applied = video?.settings ?? DEFAULT_VIDEO_SETTINGS
  const processing = state?.status === "extracting"
  const duration = result?.source.durationSec ?? 0
  const fractional = duration < FRACTIONAL_TIMESTAMP_BELOW_SEC
  const at = (seconds: number) => formatVideoTimestamp(seconds, fractional)

  // Local edits, re-seeded whenever the applied settings change underneath
  // (a run normalises them, a retry replaces them). Adjusted during render
  // rather than in an effect, the pattern `ModelPicker` uses for its overlay.
  const [draft, setDraft] = useState(applied)
  const [seededFrom, setSeededFrom] = useState(applied)
  if (seededFrom !== applied) {
    setSeededFrom(applied)
    setDraft(applied)
  }

  const isGif = result?.source.kind === "gif"
  const nativeBlockedBy = !routeVerdict.available
    ? t("nativeUnavailable", { reason: t(`nativeReason.${routeVerdict.reason}` as never) })
    : isGif
      ? t("nativeGifUnavailable")
      : null
  const trimBlocked =
    draft.delivery === "native" && result !== undefined && !result.nativeTrimSupported
  const dirty = !sameVideoSettings(draft, applied)
  const canApply = result !== undefined && !processing && dirty

  const setDelivery = (value: string) => {
    if (!value) return
    const next = withVideoDelivery(draft, value as VideoDelivery)
    // A range the native path cannot cut is dropped rather than silently ignored.
    setDraft(
      next.delivery === "native" && result && !result.nativeTrimSupported
        ? { ...next, range: null }
        : next
    )
  }

  const bounds = draft.delivery === "native" ? null : VIDEO_FRAME_COUNT_BOUNDS[draft.delivery]
  const range = draft.range ?? { startSec: 0, endSec: duration }
  const imageBytes = useMemo(
    () => result?.sampled.images.reduce((sum, image) => sum + image.bytes, 0) ?? 0,
    [result]
  )

  return (
    <div className="space-y-4" data-testid="video-preprocess-panel">
      {result ? (
        <p className="text-xs text-muted-foreground">
          {[
            isGif
              ? t("sourceGif", {
                  duration: at(duration),
                  frames: result.source.frameCount ?? 0,
                  width: result.source.width,
                  height: result.source.height,
                })
              : t("sourceVideo", {
                  duration: at(duration),
                  width: result.source.width,
                  height: result.source.height,
                }),
            t(`engine.${result.engine}` as never),
          ].join(" · ")}
        </p>
      ) : null}

      {/* ── Delivery ─────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t("deliveryLabel")}</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={draft.delivery}
          onValueChange={setDelivery}
          disabled={processing}
          aria-label={t("deliveryLabel")}
        >
          {DELIVERIES.map((delivery) => (
            <ToggleGroupItem
              key={delivery}
              value={delivery}
              disabled={delivery === "native" && nativeBlockedBy !== null}
            >
              {t(`delivery.${delivery}` as never)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">
          {t(`delivery.${draft.delivery}Hint` as never)}
        </p>
        {nativeBlockedBy ? (
          <p className="text-xs text-muted-foreground" data-testid="native-blocked">
            {nativeBlockedBy}
          </p>
        ) : null}
      </div>

      {/* ── Sampling ─────────────────────────────────────────────── */}
      {bounds ? (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("strategyLabel")}</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={draft.strategy}
              onValueChange={(value) =>
                value && setDraft({ ...draft, strategy: value as VideoSamplingStrategy })
              }
              disabled={processing}
              aria-label={t("strategyLabel")}
            >
              {STRATEGIES.map((strategy) => (
                <ToggleGroupItem key={strategy} value={strategy}>
                  {t(`strategy.${strategy}` as never)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs" id={frameCountLabelId}>
                {t("frameCountLabel")}
              </Label>
              <span className="text-xs tabular-nums text-muted-foreground">{draft.frameCount}</span>
            </div>
            <Slider
              min={bounds.min}
              max={bounds.max}
              step={1}
              value={[draft.frameCount]}
              onValueChange={([value]) =>
                value !== undefined && setDraft({ ...draft, frameCount: value })
              }
              disabled={processing}
              aria-labelledby={frameCountLabelId}
            />
          </div>
        </>
      ) : null}

      {/* ── Range ────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs">{t("rangeLabel")}</Label>
          <span className="text-xs tabular-nums text-muted-foreground">
            {draft.range
              ? t("rangeValue", { start: at(range.startSec), end: at(range.endSec) })
              : t("rangeWhole")}
          </span>
        </div>
        <SliderPrimitive.Root
          className="relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50"
          min={0}
          max={Math.max(duration, 0.001)}
          step={fractional ? 0.1 : 1}
          minStepsBetweenThumbs={1}
          value={[range.startSec, range.endSec]}
          onValueChange={([startSec, endSec]) =>
            startSec !== undefined &&
            endSec !== undefined &&
            setDraft({ ...draft, range: { startSec, endSec } })
          }
          disabled={processing || !result || trimBlocked}
        >
          <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-pill bg-muted">
            <SliderPrimitive.Range className="absolute h-full bg-primary" />
          </SliderPrimitive.Track>
          {[t("rangeStartAria"), t("rangeEndAria")].map((label) => (
            <SliderPrimitive.Thumb
              key={label}
              aria-label={label}
              className="block size-4 shrink-0 rounded-pill border border-primary bg-background shadow-sm ring-ring/50 transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden"
            />
          ))}
        </SliderPrimitive.Root>
        <div className="flex items-center justify-between gap-2">
          {trimBlocked ? (
            <p className="text-xs text-muted-foreground" data-testid="trim-blocked">
              {t("nativeFailure.trim-unavailable")}
            </p>
          ) : (
            <span />
          )}
          {/* Only offered while a range is set: with none, the value above
              already reads "Whole clip". */}
          {draft.range ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              disabled={processing}
              onClick={() => setDraft({ ...draft, range: null })}
            >
              {t("rangeWhole")}
            </Button>
          ) : null}
        </div>
      </div>

      {/* ── Apply ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!canApply}
          onClick={() => onApply(normalizeVideoSettings(draft, duration))}
        >
          {processing ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
          {processing ? t("applying") : t("apply")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={processing || sameVideoSettings(draft, DEFAULT_VIDEO_SETTINGS)}
          onClick={() => setDraft(DEFAULT_VIDEO_SETTINGS)}
        >
          <RotateCcwIcon className="size-3.5" aria-hidden />
          {t("reset")}
        </Button>
        {dirty && result && !processing ? (
          <span className="text-xs text-muted-foreground">{t("pendingChanges")}</span>
        ) : null}
      </div>

      {processing ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("processing")}</p>
          <Progress value={Math.round((video?.progress ?? 0) * 100)} aria-label={t("processing")} />
        </div>
      ) : null}

      {video?.error && !processing ? (
        <Alert variant="destructive">
          <AlertTriangleIcon className="size-4" aria-hidden />
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{errorMessage(t, video.error)}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => onApply(applied)}>
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ── What the model receives ──────────────────────────────── */}
      {result ? (
        <VideoOutput
          filename={filename}
          result={result}
          imageBytes={imageBytes}
          fractional={fractional}
        />
      ) : null}
    </div>
  )
}

type Translator = ReturnType<typeof useTranslations<"chat.composer.attachments.video">>

function errorMessage(t: Translator, error: NonNullable<StagedAttachmentState["video"]>["error"]) {
  if (!error) return ""
  if (error.reason === "too-large") {
    return t("error.tooLarge", { max: COMPOSER_VIDEO_SOURCE_MAX_BYTES / (1024 * 1024) })
  }
  if (error.reason === "undecodable") {
    if (error.ffmpeg === "missing") return t("error.ffmpegMissing")
    if (error.ffmpeg === "failed") return t("error.ffmpegFailed")
    return t("error.undecodable")
  }
  return t("error.failed", { message: error.message })
}

function VideoOutput({
  filename,
  result,
  imageBytes,
  fractional,
}: {
  filename: string
  result: NonNullable<NonNullable<StagedAttachmentState["video"]>["result"]>
  imageBytes: number
  fractional: boolean
}) {
  const t = useTranslations("chat.composer.attachments.video")
  const { sampled, native, nativeFailure, settings } = result
  // One frame is always the opening frame, so it says nothing about cuts.
  const noCuts =
    settings.delivery !== "native" &&
    settings.strategy === "scene" &&
    sampled.frames.length > 1 &&
    !sampled.frames.some((frame) => frame.reason === "scene")

  return (
    <section className="space-y-2" aria-label={t("outputTitle")}>
      <h4 className="text-xs font-medium">{t("outputTitle")}</h4>

      {settings.delivery === "native" ? (
        native ? (
          <div className="space-y-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:${result.poster.mediaType};base64,${result.poster.base64}`}
              alt={t("frameAlt", {
                time: formatVideoTimestamp(sampled.frames[0]?.timeSec ?? 0, fractional),
              })}
              className="max-h-[30vh] w-auto rounded-md border object-contain"
            />
            <p className="text-xs text-muted-foreground">
              {t("nativeReady", { size: formatBytesCompact(native.bytes) })}
            </p>
            <p className="text-xs text-muted-foreground">{t("nativeFallbackNote")}</p>
          </div>
        ) : (
          <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="native-failure">
            {t(`nativeFailure.${nativeFailure ?? "failed"}` as never)}
          </p>
        )
      ) : null}

      {settings.delivery !== "native" || !native ? (
        sampled.delivery === "storyboard" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`data:${sampled.images[0]?.mediaType};base64,${sampled.images[0]?.base64}`}
            alt={t("storyboardAlt", { filename })}
            className="max-h-[45vh] w-auto rounded-md border object-contain"
            data-testid="video-storyboard"
          />
        ) : (
          <ul className="grid grid-cols-3 gap-1.5" data-testid="video-frames">
            {sampled.images.map((image, index) => {
              const time = formatVideoTimestamp(sampled.frames[index]?.timeSec ?? 0, fractional)
              return (
                <li key={index} className="space-y-0.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:${image.mediaType};base64,${image.base64}`}
                    alt={t("frameAlt", { time })}
                    className="aspect-video w-full rounded border object-cover"
                  />
                  <span className="block text-[10px] tabular-nums text-muted-foreground">
                    {time}
                  </span>
                </li>
              )
            })}
          </ul>
        )
      ) : null}

      {settings.delivery !== "native" || !native ? (
        <p className="text-xs text-muted-foreground">
          {t("estimate", {
            tokens: sampled.estimatedImageTokens,
            size: formatBytesCompact(imageBytes),
          })}
        </p>
      ) : null}
      {noCuts ? <p className="text-xs text-muted-foreground">{t("sceneNoCuts")}</p> : null}
      {result.browserFailure ? (
        <p className="text-xs text-muted-foreground">{t("browserFailed")}</p>
      ) : null}
    </section>
  )
}

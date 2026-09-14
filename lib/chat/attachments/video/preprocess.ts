/**
 * Turn one staged video or animated GIF into what the model receives.
 *
 * The orchestration of the motion pipeline, and nothing else: which engine
 * opens the file (GIF compositor, then `<video>`, then desktop ffmpeg), how
 * many frames at what size, how they are packed (one storyboard or separate
 * frames), and — when native delivery was asked for — the file itself.
 *
 * A sampled result is ALWAYS produced, including for `native`. The route that
 * decides whether a native file may be sent is only settled at send time (the
 * controller re-checks it against the resolved model), and falling back must
 * not require re-reading a 500 MB source the user may have long since moved.
 */

import type { SendContentBlock } from "@cognia/agent-config-types"
import { encodePixelBuffer } from "@/lib/images/codec"
import type { PixelBuffer } from "@/lib/images/pixel-buffer"
import { bytesToBase64 } from "@/lib/ocr/image-prep"
import { COMPOSER_MAX_ATTACHMENT_BYTES, COMPOSER_VIDEO_SOURCE_MAX_BYTES } from "../prepare"
import { openBrowserVideoSource } from "./browser-source"
import { isGifDescriptor, videoMediaTypeOf } from "./classify"
import { describeVideoForModel, type VideoSourceInfo } from "./describe"
import { canUseLocalFfmpeg, openFfmpegVideoSource } from "./ffmpeg-source"
import {
  NativeVideoPrepareError,
  VideoPreprocessError,
  sampleFrames,
  throwIfAborted,
  type FrameBox,
  type MotionEngine,
  type MotionFrameSource,
  type NativeVideoPrepareFailure,
} from "./frame-source"
import { openGifFrameSource } from "./gif-source"
import { estimateImageTokens } from "./image-tokens"
import {
  VIDEO_FRAME_COUNT_BOUNDS,
  isVideoTrimmed,
  normalizeVideoSettings,
  resolveVideoRange,
  type VideoPreprocessSettings,
} from "./settings"
import {
  TRANSPARENT_FLATTEN_COLOR,
  composeStoryboard,
  fitBuffer,
  flattenOnto,
  storyboardLayout,
} from "./storyboard"
import {
  FRACTIONAL_TIMESTAMP_BELOW_SEC,
  formatVideoTimestamp,
  sceneCandidateCount,
  type SampledFrameReason,
} from "./timeline"

/** Long edge of each image in `frames` delivery. A frame is detail, not a thumbnail. */
export const FRAME_MAX_LONG_EDGE = 1024
/** Long edge of the poster the chip and the transcript card show. */
export const POSTER_MAX_LONG_EDGE = 512
export const VIDEO_JPEG_QUALITY = 0.85
/** Second attempt when the derived images come out over the attachment ceiling. */
export const VIDEO_JPEG_RETRY_QUALITY = 0.6

export interface EncodedFrameImage {
  mediaType: string
  base64: string
  /** Decoded byte size. */
  bytes: number
  width: number
  height: number
}

export interface SampledVideoOutput {
  delivery: "storyboard" | "frames"
  frames: Array<{ timeSec: number; reason: SampledFrameReason }>
  grid?: { columns: number; rows: number }
  images: EncodedFrameImage[]
  description: string
  /** The description text block followed by the image blocks, in send order. */
  blocks: SendContentBlock[]
  estimatedImageTokens: number
}

export interface NativeVideoOutput {
  mediaType: string
  bytes: number
  description: string
  /** The description text block followed by the base64 `document` block. */
  blocks: SendContentBlock[]
}

export interface VideoPreprocessResult {
  engine: MotionEngine
  /** Why the webview could not open the file, when ffmpeg did instead. */
  browserFailure?: string
  source: VideoSourceInfo
  /** The settings as applied: normalised against the clip. */
  settings: VideoPreprocessSettings
  sampled: SampledVideoOutput
  /** Present only when `settings.delivery === "native"` and the file could be prepared. */
  native: NativeVideoOutput | null
  /** Why native delivery was asked for but could not be prepared. */
  nativeFailure: NativeVideoPrepareFailure | null
  /** Whether a trim can be honoured for native delivery here (decision D6). */
  nativeTrimSupported: boolean
  poster: EncodedFrameImage
}

export type MotionPreprocessOutcome =
  | { kind: "motion"; result: VideoPreprocessResult }
  /** A GIF with a single frame: it is an image and takes the image path. */
  | { kind: "still-gif" }

export interface MotionPreprocessRequest {
  blob: Blob
  filename: string
  mediaType: string
  settings: VideoPreprocessSettings
  signal?: AbortSignal
  /** 0..1, monotone. */
  onProgress?: (fraction: number) => void
}

export interface PreprocessDeps {
  openGif(blob: Blob): Promise<MotionFrameSource | null>
  openBrowser(blob: Blob, mediaType: string): Promise<MotionFrameSource>
  openFfmpeg(blob: Blob, mediaType: string, filename: string): Promise<MotionFrameSource>
  canUseFfmpeg(): boolean
  encodeJpeg(
    buffer: PixelBuffer,
    quality: number
  ): Promise<{ bytes: Uint8Array; mediaType: string }>
}

export const defaultPreprocessDeps: PreprocessDeps = {
  openGif: (blob) => openGifFrameSource(blob),
  openBrowser: (blob, mediaType) => openBrowserVideoSource(blob, mediaType),
  openFfmpeg: (blob, mediaType, filename) => openFfmpegVideoSource(blob, mediaType, filename),
  canUseFfmpeg: canUseLocalFfmpeg,
  encodeJpeg: (buffer, quality) =>
    encodePixelBuffer(flattenOnto(buffer, TRANSPARENT_FLATTEN_COLOR), { format: "jpeg", quality }),
}

async function openSource(
  request: MotionPreprocessRequest,
  deps: PreprocessDeps
): Promise<{ source: MotionFrameSource; browserFailure?: string } | null> {
  const descriptor = { name: request.filename, mediaType: request.mediaType }
  if (isGifDescriptor(descriptor)) {
    const gif = await deps.openGif(request.blob)
    return gif ? { source: gif } : null
  }
  const mediaType = videoMediaTypeOf(descriptor) ?? request.mediaType
  try {
    return { source: await deps.openBrowser(request.blob, mediaType) }
  } catch (error) {
    if (!(error instanceof VideoPreprocessError) || error.reason !== "undecodable") throw error
    if (!deps.canUseFfmpeg()) {
      throw new VideoPreprocessError("undecodable", error.message, "not-available-here")
    }
    throwIfAborted(request.signal)
    const source = await deps.openFfmpeg(request.blob, mediaType, request.filename)
    return { source, browserFailure: error.message }
  }
}

function toEncoded(
  encoded: { bytes: Uint8Array; mediaType: string },
  buffer: PixelBuffer
): EncodedFrameImage {
  return {
    mediaType: encoded.mediaType,
    base64: bytesToBase64(encoded.bytes),
    bytes: encoded.bytes.byteLength,
    width: buffer.width,
    height: buffer.height,
  }
}

export async function preprocessMotionAttachment(
  request: MotionPreprocessRequest,
  deps: PreprocessDeps = defaultPreprocessDeps
): Promise<MotionPreprocessOutcome> {
  const { signal } = request
  throwIfAborted(signal)
  if (request.blob.size > COMPOSER_VIDEO_SOURCE_MAX_BYTES) {
    throw new VideoPreprocessError(
      "too-large",
      "the source is over the local preprocessing ceiling"
    )
  }

  let progressDone = 0
  let progressTotal = 1
  const report = () =>
    request.onProgress?.(Math.min(1, progressTotal > 0 ? progressDone / progressTotal : 0))

  const opened = await openSource(request, deps)
  if (!opened) return { kind: "still-gif" }
  const { source, browserFailure } = opened
  const isGif = source.info.kind === "gif"

  try {
    const info = source.info
    const settings = normalizeVideoSettings(request.settings, info.durationSec)
    const range = resolveVideoRange(settings, info.durationSec)
    const trimmed = isVideoTrimmed(settings)
    const delivery = settings.delivery === "frames" ? "frames" : "storyboard"
    const bounds = VIDEO_FRAME_COUNT_BOUNDS[delivery]
    const frameCount = Math.min(bounds.max, Math.max(bounds.min, settings.frameCount))

    let layout =
      delivery === "storyboard" ? storyboardLayout(frameCount, info.width, info.height) : null
    const box: FrameBox = layout
      ? { maxWidth: layout.cellWidth, maxHeight: layout.cellHeight }
      : { maxWidth: FRAME_MAX_LONG_EDGE, maxHeight: FRAME_MAX_LONG_EDGE }

    progressTotal =
      (settings.strategy === "scene" ? sceneCandidateCount(frameCount) : 0) + frameCount + 2
    report()
    const frames = await sampleFrames(source, settings, frameCount, box, {
      signal,
      onFrame: () => {
        progressDone += 1
        report()
      },
    })
    if (frames.length === 0) {
      throw new VideoPreprocessError("undecodable", "no frames could be sampled")
    }
    if (layout && frames.length !== frameCount) {
      // A short GIF has fewer distinct frames than were asked for.
      layout = storyboardLayout(frames.length, info.width, info.height)
    }

    const fractional = info.durationSec < FRACTIONAL_TIMESTAMP_BELOW_SEC
    const pictures: PixelBuffer[] = layout
      ? [
          composeStoryboard(
            frames.map((frame) => frame.buffer),
            frames.map((frame) => formatVideoTimestamp(frame.timeSec, fractional)),
            layout
          ),
        ]
      : frames.map((frame) => frame.buffer)

    const encodeAll = async (quality: number) => {
      const out: EncodedFrameImage[] = []
      for (const picture of pictures) {
        throwIfAborted(signal)
        out.push(toEncoded(await deps.encodeJpeg(picture, quality), picture))
      }
      return out
    }
    let images = await encodeAll(VIDEO_JPEG_QUALITY)
    const totalBytes = (list: EncodedFrameImage[]) =>
      list.reduce((sum, image) => sum + image.bytes, 0)
    if (totalBytes(images) > COMPOSER_MAX_ATTACHMENT_BYTES) {
      images = await encodeAll(VIDEO_JPEG_RETRY_QUALITY)
      if (totalBytes(images) > COMPOSER_MAX_ATTACHMENT_BYTES) {
        throw new VideoPreprocessError(
          "too-large",
          "the sampled frames are over the attachment ceiling"
        )
      }
    }
    progressDone += 1
    report()

    const frameFacts = frames.map(({ timeSec, reason }) => ({ timeSec, reason }))
    const grid = layout ? { columns: layout.columns, rows: layout.rows } : undefined
    const description = describeVideoForModel({
      filename: request.filename,
      source: info,
      delivery,
      strategy: settings.strategy,
      range,
      trimmed,
      frames: frameFacts,
      grid,
    })
    const sampled: SampledVideoOutput = {
      delivery,
      frames: frameFacts,
      ...(grid ? { grid } : {}),
      images,
      description,
      blocks: [
        { type: "text", text: description },
        ...images.map((image): SendContentBlock => ({
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.base64 },
        })),
      ],
      estimatedImageTokens: images.reduce(
        (sum, image) => sum + estimateImageTokens(image.width, image.height),
        0
      ),
    }

    const posterBuffer = fitBuffer(frames[0]!.buffer, POSTER_MAX_LONG_EDGE, POSTER_MAX_LONG_EDGE)
    const poster = toEncoded(await deps.encodeJpeg(posterBuffer, VIDEO_JPEG_QUALITY), posterBuffer)

    const nativeTrimSupported = !isGif && (source.engine === "ffmpeg" || deps.canUseFfmpeg())
    let native: NativeVideoOutput | null = null
    let nativeFailure: NativeVideoPrepareFailure | null = null
    if (settings.delivery === "native") {
      try {
        let file: { bytes: Uint8Array; mediaType: string }
        if (isGif || !trimmed || source.engine === "ffmpeg") {
          file = await source.readNative(settings.range, signal)
        } else if (deps.canUseFfmpeg()) {
          const cutter = await deps.openFfmpeg(request.blob, info.mediaType, request.filename)
          try {
            file = await cutter.readNative(settings.range, signal)
          } finally {
            await cutter.close()
          }
        } else {
          throw new NativeVideoPrepareError(
            "trim-unavailable",
            "trimming for native delivery needs ffmpeg on a desktop host"
          )
        }
        const nativeDescription = describeVideoForModel({
          filename: request.filename,
          source: info,
          delivery: "native",
          strategy: settings.strategy,
          range,
          trimmed,
          frames: [],
        })
        native = {
          mediaType: file.mediaType,
          bytes: file.bytes.byteLength,
          description: nativeDescription,
          blocks: [
            { type: "text", text: nativeDescription },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: file.mediaType,
                data: bytesToBase64(file.bytes),
              },
            },
          ],
        }
      } catch (error) {
        if (error instanceof VideoPreprocessError && error.reason === "aborted") throw error
        nativeFailure =
          error instanceof NativeVideoPrepareError
            ? error.reason
            : error instanceof VideoPreprocessError && error.ffmpeg === "missing"
              ? "ffmpeg-missing"
              : "failed"
      }
    }
    progressDone = progressTotal
    report()

    return {
      kind: "motion",
      result: {
        engine: source.engine,
        ...(browserFailure ? { browserFailure } : {}),
        source: info,
        settings,
        sampled,
        native,
        nativeFailure,
        nativeTrimSupported,
        poster,
      },
    }
  } finally {
    await source.close()
  }
}

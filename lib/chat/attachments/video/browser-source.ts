/**
 * The browser engine: an off-DOM `<video>` element, seeked and drawn to a canvas.
 *
 * It runs in all three shells with no native dependency, which is why it is
 * tried first (decision D4). Its limit is the webview's own codec list: WKWebView
 * plays HEVC but not WebM/VP9 everywhere, Chromium the reverse, and neither
 * opens MKV or AVI. A file it cannot decode is reported as `undecodable` so the
 * orchestrator can hand it to ffmpeg on a desktop host.
 *
 * The element is played by nobody: it is muted, never attached to the document,
 * and only ever asked to seek. Its object URL is revoked on close.
 */

import type { PixelBuffer } from "@/lib/images/pixel-buffer"
import type { VideoRange } from "./settings"
import {
  NativeVideoPrepareError,
  VideoPreprocessError,
  throwIfAborted,
  type FrameBox,
  type MotionFrameSource,
} from "./frame-source"
import { NATIVE_VIDEO_MAX_BYTES } from "./delivery-gate"

/** The slice of `HTMLVideoElement` this engine touches. */
export interface VideoElementLike {
  src: string
  muted: boolean
  preload: string
  playsInline: boolean
  currentTime: number
  readonly duration: number
  readonly videoWidth: number
  readonly videoHeight: number
  readonly readyState: number
  readonly error: { code: number; message?: string } | null
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  load(): void
  pause(): void
  removeAttribute(name: string): void
}

export interface BrowserSourceDeps {
  createVideo(): VideoElementLike
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
  /** Draw the element's current frame at `width × height` and read the pixels back. */
  drawFrame(video: VideoElementLike, width: number, height: number): PixelBuffer
  /** Per-wait ceiling for metadata and each seek. */
  timeoutMs: number
}

const HAVE_CURRENT_DATA = 2

/** Media types the provider that accepts native video (Gemini) documents. */
export const NATIVE_VIDEO_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/x-msvideo",
  "video/avi",
  "video/x-flv",
  "video/mpg",
  "video/webm",
  "video/x-ms-wmv",
  "video/wmv",
  "video/3gpp",
])

function defaultDrawFrame(video: VideoElementLike, width: number, height: number): PixelBuffer {
  // A DOM canvas, not OffscreenCanvas: drawing an HTMLVideoElement into an
  // OffscreenCanvas context is not supported by every WebKit build we ship on.
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) throw new VideoPreprocessError("failed", "no 2D canvas available")
  context.drawImage(video as unknown as CanvasImageSource, 0, 0, width, height)
  const image = context.getImageData(0, 0, width, height)
  return { data: image.data, width: image.width, height: image.height }
}

export const defaultBrowserSourceDeps: BrowserSourceDeps = {
  createVideo: () => document.createElement("video") as unknown as VideoElementLike,
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  drawFrame: defaultDrawFrame,
  timeoutMs: 15_000,
}

/**
 * Resolve on the first of `events`, reject on `error` or the timeout. Listeners
 * are always removed, whichever way it ends.
 */
function waitFor(
  video: VideoElementLike,
  events: readonly string[],
  timeoutMs: number,
  what: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      for (const event of events) video.removeEventListener(event, onEvent)
      video.removeEventListener("error", onError)
    }
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(
        new VideoPreprocessError(
          "undecodable",
          `the webview cannot decode this video (${what}: ${video.error?.message || `code ${video.error?.code ?? "?"}`})`
        )
      )
    }
    for (const event of events) video.addEventListener(event, onEvent)
    video.addEventListener("error", onError)
    timer = setTimeout(() => {
      cleanup()
      reject(new VideoPreprocessError("undecodable", `timed out waiting for ${what}`))
    }, timeoutMs)
  })
}

/** Fit `width × height` inside `box` (never upscaling), as whole even-ish pixels. */
function fitSize(width: number, height: number, box: FrameBox): { width: number; height: number } {
  const scale = Math.min(1, box.maxWidth / width, box.maxHeight / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export async function openBrowserVideoSource(
  blob: Blob,
  mediaType: string,
  deps: BrowserSourceDeps = defaultBrowserSourceDeps
): Promise<MotionFrameSource> {
  const video = deps.createVideo()
  const url = deps.createObjectURL(blob)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    video.pause()
    video.removeAttribute("src")
    video.load()
    deps.revokeObjectURL(url)
  }

  try {
    video.muted = true
    video.preload = "auto"
    video.playsInline = true
    const metadata = waitFor(video, ["loadedmetadata"], deps.timeoutMs, "metadata")
    video.src = url
    await metadata

    // A MediaRecorder WebM carries no duration header: the element reports
    // Infinity until it has seen the end. Seeking far past the end makes it
    // scan and settle the real value.
    if (!Number.isFinite(video.duration)) {
      const settled = waitFor(video, ["durationchange", "seeked"], deps.timeoutMs, "duration")
      video.currentTime = Number.MAX_SAFE_INTEGER
      await settled
    }
    if (!(Number.isFinite(video.duration) && video.duration > 0)) {
      throw new VideoPreprocessError("undecodable", "the video reports no duration")
    }
    // An element that opens a container but not its video track (HEVC in a
    // Chromium without the codec, audio-only files) has no picture size.
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) {
      throw new VideoPreprocessError("undecodable", "the video has no decodable picture track")
    }
  } catch (error) {
    await close()
    throw error
  }

  const duration = video.duration
  const width = video.videoWidth
  const height = video.videoHeight

  const seekTo = async (timeSec: number) => {
    // Seeking to exactly `duration` yields no frame on several engines.
    const target = Math.min(Math.max(0, timeSec), Math.max(0, duration - 0.001))
    if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= HAVE_CURRENT_DATA) {
      return
    }
    const seeked = waitFor(video, ["seeked"], deps.timeoutMs, `seek to ${target.toFixed(2)}s`)
    video.currentTime = target
    await seeked
    if (video.readyState < HAVE_CURRENT_DATA) {
      await waitFor(video, ["loadeddata", "canplay"], deps.timeoutMs, "frame data")
    }
  }

  return {
    engine: "browser",
    info: { kind: "video", mediaType, durationSec: duration, width, height },
    async grab(times, box, options = {}) {
      const size = fitSize(width, height, box)
      const frames: PixelBuffer[] = []
      for (const time of times) {
        throwIfAborted(options.signal)
        await seekTo(time)
        frames.push(deps.drawFrame(video, size.width, size.height))
        options.onFrame?.()
      }
      return frames
    },
    async readNative(range: VideoRange | null, signal?: AbortSignal) {
      throwIfAborted(signal)
      if (range) {
        throw new NativeVideoPrepareError(
          "trim-unavailable",
          "trimming a video for native delivery needs ffmpeg on a desktop host"
        )
      }
      if (!NATIVE_VIDEO_MEDIA_TYPES.has(mediaType)) {
        throw new NativeVideoPrepareError(
          "format",
          `${mediaType} is not accepted as a native video`
        )
      }
      if (blob.size > NATIVE_VIDEO_MAX_BYTES) {
        throw new NativeVideoPrepareError("too-large", "the video is over the native size limit")
      }
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mediaType }
    },
    close,
  }
}

/**
 * One contract over three decoders.
 *
 * The browser `<video>` element, the GIF compositor and the desktop ffmpeg
 * fallback differ in everything except what the pipeline needs from them: the
 * clip's shape, frames at given times, and (for native delivery) the file
 * itself. {@link sampleFrames} is written once against that contract, so
 * uniform and scene sampling behave identically whichever engine opened the
 * file — which is what lets a clip fall back from the webview to ffmpeg without
 * the user getting a different storyboard for the same settings.
 */

import type { PixelBuffer } from "@/lib/images/pixel-buffer"
import type { VideoSourceInfo } from "./describe"
import { resolveVideoRange, type VideoPreprocessSettings, type VideoRange } from "./settings"
import {
  lumaSignature,
  pickSceneFrames,
  sceneCandidateCount,
  uniformSampleTimes,
  type SampledFrameReason,
} from "./timeline"

export type MotionEngine = "browser" | "ffmpeg" | "gif"

export type VideoPreprocessErrorReason =
  /** No engine available here can decode the file. */
  | "undecodable"
  /** The source is above the local preprocessing ceiling. */
  | "too-large"
  /** The run was cancelled (the attachment was removed or re-configured). */
  | "aborted"
  /** An engine failed for a reason that is not the file's format. */
  | "failed"

export class VideoPreprocessError extends Error {
  constructor(
    readonly reason: VideoPreprocessErrorReason,
    message: string,
    /** For `undecodable`: whether the desktop ffmpeg fallback was tried and why it did not help. */
    readonly ffmpeg: "not-available-here" | "missing" | "failed" | "not-tried" = "not-tried"
  ) {
    super(message)
    this.name = "VideoPreprocessError"
  }
}

/** Reasons native delivery could not be prepared, beyond what the route gate says. */
export type NativeVideoPrepareFailure =
  /** Trimming needs a re-encode, and only desktop ffmpeg can do it. */
  | "trim-unavailable"
  /** ffmpeg was needed and is not installed. */
  | "ffmpeg-missing"
  /** The original (or trimmed) file is over the native byte ceiling. */
  | "too-large"
  /** A container no video-capable provider accepts (GIF, MKV, …). */
  | "format"
  | "failed"

export class NativeVideoPrepareError extends Error {
  constructor(
    readonly reason: NativeVideoPrepareFailure,
    message: string
  ) {
    super(message)
    this.name = "NativeVideoPrepareError"
  }
}

export interface FrameBox {
  maxWidth: number
  maxHeight: number
}

export interface GrabOptions {
  signal?: AbortSignal
  /** Called once per frame grabbed, for progress. */
  onFrame?: () => void
}

export interface MotionFrameSource {
  readonly engine: MotionEngine
  readonly info: VideoSourceInfo
  /** Frames at `times` (seconds), each fitted inside `box`, in the order asked. */
  grab(times: readonly number[], box: FrameBox, options?: GrabOptions): Promise<PixelBuffer[]>
  /**
   * The same frame is shown for every time that maps to one key. A GIF has a
   * finite frame list, so asking it for nine times across a four-frame loop
   * would otherwise produce a storyboard of repeats. Absent for continuous video.
   */
  frameKeyAt?(timeSec: number): number
  /** The file to send natively, trimmed to `range` when one is given. */
  readNative(
    range: VideoRange | null,
    signal?: AbortSignal
  ): Promise<{ bytes: Uint8Array; mediaType: string }>
  close(): Promise<void>
}

/** Scene candidates only need enough pixels for a 16×16 signature. */
export const SIGNATURE_GRAB_BOX: FrameBox = { maxWidth: 96, maxHeight: 96 }

export interface SampledFrame {
  timeSec: number
  reason: SampledFrameReason
  buffer: PixelBuffer
}

export function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted)
    throw new VideoPreprocessError("aborted", "video preprocessing was cancelled")
}

/**
 * Sample frames per `settings` (already normalised against the clip).
 *
 * Scene sampling grabs small candidates first, picks from their signatures,
 * then grabs only the picks at full size — so a 36-candidate scan costs 36
 * thumbnail decodes plus nine real ones, not 36 full frames held in memory.
 */
export async function sampleFrames(
  source: MotionFrameSource,
  settings: VideoPreprocessSettings,
  frameCount: number,
  box: FrameBox,
  options: GrabOptions = {}
): Promise<SampledFrame[]> {
  const range = resolveVideoRange(settings, source.info.durationSec)
  let picks: Array<{ timeSec: number; reason: SampledFrameReason }>

  if (settings.strategy === "scene") {
    const candidateTimes = uniformSampleTimes(range, sceneCandidateCount(frameCount))
    const thumbnails = await source.grab(candidateTimes, SIGNATURE_GRAB_BOX, options)
    throwIfAborted(options.signal)
    const picked = pickSceneFrames(
      candidateTimes.map((timeSec, i) => ({ timeSec, signature: lumaSignature(thumbnails[i]!) })),
      frameCount
    )
    picks = picked.map(({ index, reason }) => ({ timeSec: candidateTimes[index]!, reason }))
  } else {
    picks = uniformSampleTimes(range, frameCount).map((timeSec) => ({
      timeSec,
      reason: "uniform" as const,
    }))
  }

  if (source.frameKeyAt) {
    const seen = new Set<number>()
    picks = picks.filter((pick) => {
      const key = source.frameKeyAt!(pick.timeSec)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const buffers = await source.grab(
    picks.map((pick) => pick.timeSec),
    box,
    options
  )
  throwIfAborted(options.signal)
  return picks.map((pick, i) => ({ ...pick, buffer: buffers[i]! }))
}

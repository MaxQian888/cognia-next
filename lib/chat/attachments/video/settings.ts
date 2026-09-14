/**
 * What the user asked the motion pipeline to do with one attachment.
 *
 * Kept free of anything decoded: settings are chosen before (and independently
 * of) a sampling run, persisted with a draft, and re-applied to a re-staged
 * file. {@link normalizeVideoSettings} is the one place a raw value — from the
 * panel, a draft row, or a default — is fitted to the clip it describes.
 */

/** How the clip reaches the model. */
export type VideoDelivery = "storyboard" | "frames" | "native"

/** How sample times are chosen. `native` ignores it. */
export type VideoSamplingStrategy = "uniform" | "scene"

export interface VideoRange {
  startSec: number
  endSec: number
}

export interface VideoPreprocessSettings {
  delivery: VideoDelivery
  strategy: VideoSamplingStrategy
  /** Frames to sample for `storyboard` / `frames`. Not read by `native`. */
  frameCount: number
  /** The part of the clip to use. `null` means all of it. */
  range: VideoRange | null
}

/** Frame-count bounds per sampled delivery. */
export const VIDEO_FRAME_COUNT_BOUNDS = {
  storyboard: { min: 4, max: 16, default: 9 },
  frames: { min: 1, max: 12, default: 6 },
} as const satisfies Record<
  Exclude<VideoDelivery, "native">,
  { min: number; max: number; default: number }
>

/**
 * Shortest range a trim may select. Short enough for a GIF loop, long enough
 * that a slider dragged onto itself cannot produce an empty clip.
 */
export const VIDEO_MIN_RANGE_SEC = 0.5

/** Decision D5: an untouched attachment becomes a 9-frame uniform storyboard. */
export const DEFAULT_VIDEO_SETTINGS: VideoPreprocessSettings = Object.freeze({
  delivery: "storyboard",
  strategy: "uniform",
  frameCount: VIDEO_FRAME_COUNT_BOUNDS.storyboard.default,
  range: null,
}) as VideoPreprocessSettings

/** A range this close to the clip's edges is "the whole clip". */
const EDGE_EPSILON_SEC = 0.05

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function frameBounds(delivery: VideoDelivery) {
  return delivery === "native"
    ? VIDEO_FRAME_COUNT_BOUNDS.storyboard
    : VIDEO_FRAME_COUNT_BOUNDS[delivery]
}

/**
 * Fit settings to a clip of `durationSec`: frame count into its delivery's
 * bounds, the range inside the clip and at least {@link VIDEO_MIN_RANGE_SEC}
 * long, and a range that covers the whole clip collapsed to `null`.
 */
export function normalizeVideoSettings(
  settings: VideoPreprocessSettings,
  durationSec: number
): VideoPreprocessSettings {
  const bounds = frameBounds(settings.delivery)
  const frameCount = Number.isFinite(settings.frameCount)
    ? clamp(Math.round(settings.frameCount), bounds.min, bounds.max)
    : bounds.default

  let range: VideoRange | null = null
  if (settings.range && Number.isFinite(durationSec) && durationSec > 0) {
    const minLength = Math.min(VIDEO_MIN_RANGE_SEC, durationSec)
    let start = clamp(
      Number.isFinite(settings.range.startSec) ? settings.range.startSec : 0,
      0,
      durationSec
    )
    let end = clamp(
      Number.isFinite(settings.range.endSec) ? settings.range.endSec : durationSec,
      0,
      durationSec
    )
    if (end < start) [start, end] = [end, start]
    if (end - start < minLength) {
      end = Math.min(durationSec, start + minLength)
      start = Math.max(0, end - minLength)
    }
    const whole = start <= EDGE_EPSILON_SEC && end >= durationSec - EDGE_EPSILON_SEC
    range = whole ? null : { startSec: start, endSec: end }
  }

  return { delivery: settings.delivery, strategy: settings.strategy, frameCount, range }
}

/**
 * Switch delivery, keeping the frame count when it still fits the new
 * delivery's bounds and resetting it to that delivery's default when it does
 * not (a 16-frame storyboard becoming 12 separate images would be a surprise).
 */
export function withVideoDelivery(
  settings: VideoPreprocessSettings,
  delivery: VideoDelivery
): VideoPreprocessSettings {
  if (delivery === settings.delivery) return settings
  const bounds = frameBounds(delivery)
  const fits = settings.frameCount >= bounds.min && settings.frameCount <= bounds.max
  return {
    ...settings,
    delivery,
    frameCount: delivery === "native" || fits ? settings.frameCount : bounds.default,
  }
}

/** The range a run actually covers. */
export function resolveVideoRange(
  settings: VideoPreprocessSettings,
  durationSec: number
): VideoRange {
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  return settings.range ?? { startSec: 0, endSec: duration }
}

export function isVideoTrimmed(settings: VideoPreprocessSettings): boolean {
  return settings.range !== null
}

export function sameVideoSettings(a: VideoPreprocessSettings, b: VideoPreprocessSettings): boolean {
  return (
    a.delivery === b.delivery &&
    a.strategy === b.strategy &&
    a.frameCount === b.frameCount &&
    (a.range === b.range ||
      (a.range !== null &&
        b.range !== null &&
        a.range.startSec === b.range.startSec &&
        a.range.endSec === b.range.endSec))
  )
}

const DELIVERIES: ReadonlySet<string> = new Set(["storyboard", "frames", "native"])
const STRATEGIES: ReadonlySet<string> = new Set(["uniform", "scene"])

/**
 * Structural check for a value read back from storage. A draft row is written
 * by this build but read by whatever build opens it, so it is parsed, not cast.
 */
export function isVideoPreprocessSettings(value: unknown): value is VideoPreprocessSettings {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (typeof v.delivery !== "string" || !DELIVERIES.has(v.delivery)) return false
  if (typeof v.strategy !== "string" || !STRATEGIES.has(v.strategy)) return false
  if (typeof v.frameCount !== "number" || !Number.isFinite(v.frameCount)) return false
  if (v.range === null) return true
  if (!v.range || typeof v.range !== "object") return false
  const r = v.range as Record<string, unknown>
  return (
    typeof r.startSec === "number" &&
    Number.isFinite(r.startSec) &&
    typeof r.endSec === "number" &&
    Number.isFinite(r.endSec)
  )
}

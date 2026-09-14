/**
 * Choosing which moments of a clip the model sees.
 *
 * Engine-neutral on purpose: the browser `<video>` sampler, the GIF compositor
 * and the ffmpeg fallback all hand this module the same thing — a time and a
 * 16×16 luma signature per candidate frame — so "scene change" means the same
 * cut no matter which decoder happened to open the file.
 */

import { luma } from "@/lib/images/color"
import type { PixelBuffer } from "@/lib/images/pixel-buffer"
import type { VideoRange } from "./settings"

/** Edge of the square luma thumbnail two frames are compared by. */
export const SIGNATURE_SIZE = 16

/**
 * Mean absolute luma difference (0–255) between neighbouring candidates above
 * which the change counts as a cut. Chosen against the same 16×16 signature the
 * native analyser's de-duplication uses; a pan or a fade stays well below it.
 */
export const SCENE_CUT_THRESHOLD = 12

/** Scene detection looks at this many candidates per requested frame … */
export const SCENE_CANDIDATES_PER_FRAME = 4
/** … but never fewer than this (short requests still need context) … */
export const SCENE_CANDIDATES_MIN = 16
/** … nor more than this (each candidate is a seek on a real video). */
export const SCENE_CANDIDATES_MAX = 96

/**
 * `count` times spread evenly over `range`, each at the middle of its slice.
 *
 * Mid-slice rather than slice-start keeps the first sample off frame 0, which
 * for recordings is very often black or a title fade.
 */
export function uniformSampleTimes(range: VideoRange, count: number): number[] {
  const n = Math.max(1, Math.floor(count))
  const span = range.endSec - range.startSec
  if (!(span > 0)) return [Math.max(0, range.startSec)]
  return Array.from({ length: n }, (_, i) => range.startSec + ((i + 0.5) * span) / n)
}

/** How many candidates scene detection samples for `frameCount` wanted frames. */
export function sceneCandidateCount(frameCount: number): number {
  return Math.min(
    SCENE_CANDIDATES_MAX,
    Math.max(SCENE_CANDIDATES_MIN, Math.floor(frameCount) * SCENE_CANDIDATES_PER_FRAME)
  )
}

/**
 * A `size × size` luma thumbnail of `buffer`, box-averaged. Alpha is treated
 * as coverage over black so a transparent GIF region reads as dark rather than
 * as whatever colour its invisible pixels happen to hold.
 */
export function lumaSignature(buffer: PixelBuffer, size = SIGNATURE_SIZE): Uint8Array {
  const out = new Uint8Array(size * size)
  const { data, width, height } = buffer
  for (let sy = 0; sy < size; sy++) {
    const y0 = Math.floor((sy * height) / size)
    const y1 = Math.max(y0 + 1, Math.floor(((sy + 1) * height) / size))
    for (let sx = 0; sx < size; sx++) {
      const x0 = Math.floor((sx * width) / size)
      const x1 = Math.max(x0 + 1, Math.floor(((sx + 1) * width) / size))
      let sum = 0
      let count = 0
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const i = (y * width + x) * 4
          sum += (luma(data[i]!, data[i + 1]!, data[i + 2]!) * data[i + 3]!) / 255
          count += 1
        }
      }
      out[sy * size + sx] = count > 0 ? Math.round(sum / count) : 0
    }
  }
  return out
}

/** Mean absolute difference of two signatures, 0–255. */
export function signatureDistance(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  if (length === 0) return 0
  let total = 0
  for (let i = 0; i < length; i++) total += Math.abs(a[i]! - b[i]!)
  return total / length
}

export interface SceneCandidate {
  timeSec: number
  signature: Uint8Array
}

/** Why a sampled frame is in the set — surfaced to the user and the model. */
export type SampledFrameReason = "start" | "scene" | "uniform"

export interface PickedFrame {
  /** Index into the candidate list. */
  index: number
  reason: SampledFrameReason
}

/**
 * Pick up to `count` candidates: the first one, then the strongest cuts at
 * least a minimum spacing apart, then — for a clip with fewer clear cuts than
 * requested frames — evenly spaced fills. Returned in time order.
 *
 * The fill is not a fallback that hides itself: every fill is labelled
 * `uniform`, so a talking-head clip with no cuts says so rather than passing
 * off nine arbitrary frames as "scene changes".
 */
export function pickSceneFrames(
  candidates: readonly SceneCandidate[],
  count: number
): PickedFrame[] {
  const n = candidates.length
  if (n === 0) return []
  const wanted = Math.min(Math.max(1, Math.floor(count)), n)
  const picked = new Map<number, SampledFrameReason>([[0, "start"]])
  const minGap = Math.max(1, Math.floor(n / (wanted * 2)))
  const farEnough = (index: number) => {
    for (const p of picked.keys()) if (Math.abs(p - index) < minGap) return false
    return true
  }

  const cuts = candidates
    .map((candidate, index) =>
      index === 0
        ? null
        : {
            index,
            distance: signatureDistance(candidates[index - 1]!.signature, candidate.signature),
          }
    )
    .filter(
      (c): c is { index: number; distance: number } =>
        c !== null && c.distance >= SCENE_CUT_THRESHOLD
    )
    .sort((a, b) => b.distance - a.distance || a.index - b.index)

  for (const cut of cuts) {
    if (picked.size >= wanted) break
    if (farEnough(cut.index)) picked.set(cut.index, "scene")
  }

  if (picked.size < wanted) {
    // Evenly spaced slots, filled farthest-from-anything-picked first so the
    // fills spread into the gaps the cuts left.
    const slots = Array.from({ length: wanted }, (_, k) =>
      Math.min(n - 1, Math.max(0, Math.round(((k + 0.5) * n) / wanted - 0.5)))
    )
    const gapTo = (index: number) => Math.min(...[...picked.keys()].map((p) => Math.abs(p - index)))
    const ordered = [...new Set(slots)].sort((a, b) => gapTo(b) - gapTo(a) || a - b)
    for (const slot of ordered) {
      if (picked.size >= wanted) break
      if (!picked.has(slot)) picked.set(slot, "uniform")
    }
    for (let index = 0; index < n && picked.size < wanted; index++) {
      if (!picked.has(index)) picked.set(index, "uniform")
    }
  }

  return [...picked.entries()]
    .map(([index, reason]) => ({ index, reason }))
    .sort((a, b) => a.index - b.index)
}

/**
 * `m:ss`, `h:mm:ss` past an hour, and a tenth of a second when `fractional`
 * (short clips and GIFs, where whole seconds would label three frames alike).
 * Not localised: it is a timecode, written the same way in every locale and
 * read by the model as well as the user.
 */
export function formatVideoTimestamp(seconds: number, fractional = false): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const tenths = Math.round(safe * 10)
  const whole = fractional ? Math.floor(tenths / 10) : Math.round(safe)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const ss = String(secs).padStart(2, "0")
  const suffix = fractional ? `.${tenths % 10}` : ""
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}${suffix}`
    : `${minutes}:${ss}${suffix}`
}

/** Timestamps read ambiguously in whole seconds below this clip length. */
export const FRACTIONAL_TIMESTAMP_BELOW_SEC = 60

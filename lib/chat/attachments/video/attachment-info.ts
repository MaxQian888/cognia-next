/**
 * What a sent video leaves behind in the transcript (decision D7).
 *
 * The original file is never stored. Every part a video produced — its
 * description text, the storyboard or frames the model saw, or the poster that
 * stands in for a native file — carries one {@link VideoAttachmentInfo}, and the
 * renderer groups parts by `groupId` into a single video card.
 *
 * The shape is persisted in message rows and synced to other devices, so it is
 * read back through {@link readVideoAttachmentInfo}, never cast.
 */

import type { VideoDelivery, VideoRange, VideoSamplingStrategy } from "./settings"
import type { MotionEngine } from "./frame-source"

export interface VideoAttachmentInfo {
  /** Groups this attachment's parts into one card. Unique per attachment per message. */
  groupId: string
  filename: string
  /** The source file's media type (`video/mp4`, `image/gif`). */
  sourceMediaType: string
  kind: "video" | "gif"
  durationSec: number
  width: number
  height: number
  /** Total frames, for a GIF. */
  frameCount?: number
  /** What the model received. */
  delivery: VideoDelivery
  strategy: VideoSamplingStrategy
  range: VideoRange | null
  /** Times of the sampled frames, in seconds. Empty for `native`. */
  frameTimes: number[]
  grid?: { columns: number; rows: number }
  engine: MotionEngine
}

/**
 * Transcript key under which a part carries its {@link VideoAttachmentInfo}.
 * Spelled once so the adapter that writes it and the renderer that groups by it
 * cannot disagree.
 */
export const VIDEO_ATTACHMENT_PART_KEY = "videoAttachment" as const

const DELIVERIES = new Set(["storyboard", "frames", "native"])
const STRATEGIES = new Set(["uniform", "scene"])
const ENGINES = new Set(["browser", "ffmpeg", "gif"])

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Parse a persisted descriptor. Anything malformed reads as `null`, and the part renders as what it is. */
export function readVideoAttachmentInfo(value: unknown): VideoAttachmentInfo | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (typeof v.groupId !== "string" || !v.groupId) return null
  if (typeof v.filename !== "string" || typeof v.sourceMediaType !== "string") return null
  if (v.kind !== "video" && v.kind !== "gif") return null
  if (!finiteNumber(v.durationSec) || !finiteNumber(v.width) || !finiteNumber(v.height)) return null
  if (typeof v.delivery !== "string" || !DELIVERIES.has(v.delivery)) return null
  if (typeof v.strategy !== "string" || !STRATEGIES.has(v.strategy)) return null
  if (typeof v.engine !== "string" || !ENGINES.has(v.engine)) return null
  if (!Array.isArray(v.frameTimes) || !v.frameTimes.every(finiteNumber)) return null

  let range: VideoRange | null = null
  if (v.range !== null && v.range !== undefined) {
    const r = v.range as Record<string, unknown>
    if (!finiteNumber(r.startSec) || !finiteNumber(r.endSec)) return null
    range = { startSec: r.startSec, endSec: r.endSec }
  }
  let grid: VideoAttachmentInfo["grid"]
  if (v.grid !== undefined) {
    const g = v.grid as Record<string, unknown>
    if (!g || !finiteNumber(g.columns) || !finiteNumber(g.rows)) return null
    grid = { columns: g.columns, rows: g.rows }
  }

  return {
    groupId: v.groupId,
    filename: v.filename,
    sourceMediaType: v.sourceMediaType,
    kind: v.kind,
    durationSec: v.durationSec,
    width: v.width,
    height: v.height,
    ...(finiteNumber(v.frameCount) ? { frameCount: v.frameCount } : {}),
    delivery: v.delivery as VideoDelivery,
    strategy: v.strategy as VideoSamplingStrategy,
    range,
    frameTimes: [...v.frameTimes],
    ...(grid ? { grid } : {}),
    engine: v.engine as MotionEngine,
  }
}

/** The descriptor on a transcript part, if it carries one. */
export function videoAttachmentInfoOfPart(part: unknown): VideoAttachmentInfo | null {
  if (!part || typeof part !== "object") return null
  return readVideoAttachmentInfo((part as Record<string, unknown>)[VIDEO_ATTACHMENT_PART_KEY])
}

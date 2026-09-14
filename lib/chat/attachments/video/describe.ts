/**
 * The text block that tells the model what the pictures next to it are.
 *
 * A storyboard without it is nine unlabelled photos; a native video without it
 * is a file with no name. It carries the source's shape (duration, size), how
 * the frames were chosen, and the timestamp of each — the model then answers
 * "what happens at 0:30" against real times instead of guessing from order.
 *
 * English on purpose, like `formatDocumentText`'s `Attached file` header: it is
 * addressed to the model, never shown as UI copy (the transcript card renders
 * its own localised summary from the same facts).
 */

import type { SampledFrameReason } from "./timeline"
import { FRACTIONAL_TIMESTAMP_BELOW_SEC, formatVideoTimestamp } from "./timeline"
import type { VideoDelivery, VideoRange, VideoSamplingStrategy } from "./settings"

export interface VideoSourceInfo {
  kind: "video" | "gif"
  /** The source's media type (`video/mp4`, `image/gif`). */
  mediaType: string
  durationSec: number
  width: number
  height: number
  /** Total frames, known for a GIF. */
  frameCount?: number
}

export interface VideoDescriptionInput {
  filename: string
  source: VideoSourceInfo
  delivery: VideoDelivery
  strategy: VideoSamplingStrategy
  range: VideoRange
  trimmed: boolean
  /** The sampled frames, in time order. Empty for `native`. */
  frames: ReadonlyArray<{ timeSec: number; reason: SampledFrameReason }>
  /** Grid shape, for `storyboard`. */
  grid?: { columns: number; rows: number }
}

function durationLabel(seconds: number): string {
  return seconds < FRACTIONAL_TIMESTAMP_BELOW_SEC
    ? `${(Math.round(seconds * 10) / 10).toFixed(1)}s`
    : formatVideoTimestamp(seconds)
}

export function describeVideoForModel(input: VideoDescriptionInput): string {
  const { source, range } = input
  const fractional = source.durationSec < FRACTIONAL_TIMESTAMP_BELOW_SEC
  const at = (seconds: number) => formatVideoTimestamp(seconds, fractional)
  const shape = [
    durationLabel(source.durationSec),
    source.kind === "gif" && source.frameCount ? `${source.frameCount} frames` : null,
    source.width > 0 && source.height > 0 ? `${source.width}×${source.height}` : null,
  ]
    .filter(Boolean)
    .join(", ")
  const noun = source.kind === "gif" ? "animated GIF" : "video"
  const lines = [`Attached ${noun} "${input.filename}" (${shape}).`]

  if (input.delivery === "native") {
    lines.push(
      input.trimmed
        ? `Sent as the original video file, trimmed to ${at(range.startSec)}–${at(range.endSec)}.`
        : "Sent as the original video file."
    )
    return lines.join("\n")
  }

  const count = input.frames.length
  const span = input.trimmed
    ? `the trimmed range ${at(range.startSec)}–${at(range.endSec)}`
    : `${at(range.startSec)}–${at(range.endSec)}`
  const sceneCuts = input.frames.filter((frame) => frame.reason === "scene").length
  const how =
    input.strategy === "scene"
      ? sceneCuts > 0
        ? `at scene changes in ${span}${sceneCuts < count - 1 ? ", evenly spaced where there was no clear cut" : ""}`
        : `evenly from ${span} (no clear scene changes were found)`
      : `evenly from ${span}`

  if (input.delivery === "storyboard") {
    const grid = input.grid ? `a ${input.grid.columns}×${input.grid.rows} grid` : "a grid"
    lines.push(
      `Storyboard: one image with ${count} frame${count === 1 ? "" : "s"} sampled ${how}, laid out as ${grid} in reading order (left to right, top to bottom). Each frame is labelled with its timestamp.`
    )
  } else {
    lines.push(
      `Frames: the next ${count} image${count === 1 ? "" : "s"}, in order, sampled ${how}.`
    )
  }
  lines.push(`Frame times: ${input.frames.map((frame) => at(frame.timeSec)).join(", ")}.`)
  return lines.join("\n")
}

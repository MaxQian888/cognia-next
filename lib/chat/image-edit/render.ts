/**
 * Turning a history pipeline into pixels, and deciding what to encode it as.
 *
 * Every local step in the engine is a pure buffer-to-buffer function, so
 * replaying a pipeline is synchronous and canvas-free. Only the two ends of the
 * process need a browser: decoding the source, and encoding the result.
 */

import {
  applyAdjustments,
  chooseEncodeFormat,
  cropBuffer,
  flipBuffer,
  resizeBuffer,
  rotateQuarterTurns,
  type ImageEncodeFormat,
  type PixelBuffer,
} from "@/lib/images"

import type { LocalEntry, RenderPipeline } from "./editor-state"

/**
 * Replay `operations` onto `base`.
 *
 * Order is the order the user performed them in, which is the only order that
 * can be right: a crop after a rotate selects a different region than the same
 * crop before it.
 */
export function renderOperations(
  base: PixelBuffer,
  operations: readonly LocalEntry[]
): PixelBuffer {
  let buffer = base
  for (const operation of operations) {
    switch (operation.kind) {
      case "crop":
        buffer = cropBuffer(buffer, operation.rect)
        break
      case "resize":
        buffer = resizeBuffer(buffer, operation.width, operation.height)
        break
      case "rotate":
        buffer = rotateQuarterTurns(buffer, operation.turns)
        break
      case "flip":
        buffer = flipBuffer(buffer, {
          horizontal: operation.horizontal,
          vertical: operation.vertical,
        })
        break
      case "adjust":
        buffer = applyAdjustments(buffer, operation.adjustments)
        break
    }
  }
  return buffer
}

/**
 * Replay a pipeline, given the bitmap its base names.
 *
 * The caller resolves `baseCheckpointId` to a buffer, because the reducer
 * deliberately holds ids rather than pixels.
 */
export function renderPipeline(base: PixelBuffer, pipeline: RenderPipeline): PixelBuffer {
  return renderOperations(base, pipeline.operations)
}

export interface SaveEncodingInput {
  /** The rendered result. */
  buffer: PixelBuffer
  /** Local steps replayed on top of the base. Zero means the base is untouched. */
  operationCount: number
  /** Media type of the base bitmap when it came from a model, else `null`. */
  baseMediaType: string | null
}

export interface SaveEncoding {
  /**
   * True when the provider's own bytes should be stored verbatim.
   *
   * Re-encoding an untouched AI result would throw away whatever the provider
   * chose without gaining anything: the pixels are identical, and a round trip
   * through the canvas can only lose quality or change the format under us.
   */
  reuseBaseBytes: boolean
  /** Only meaningful when `reuseBaseBytes` is false. */
  format: ImageEncodeFormat
}

/**
 * How to persist an edit result.
 *
 * WebP is the default because these are photographic frames that will sit in a
 * transcript forever. Transparency overrides it to PNG, which
 * `chooseEncodeFormat` decides, so a background removal is not silently
 * flattened onto black.
 */
export function resolveSaveEncoding({
  buffer,
  operationCount,
  baseMediaType,
}: SaveEncodingInput): SaveEncoding {
  if (operationCount === 0 && baseMediaType) {
    return { reuseBaseBytes: true, format: "png" }
  }
  return { reuseBaseBytes: false, format: chooseEncodeFormat(buffer, "webp") }
}

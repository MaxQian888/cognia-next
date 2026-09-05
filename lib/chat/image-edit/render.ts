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

/**
 * Longest edge of the buffer the live preview renders from.
 *
 * A canonical chat image is 1568px, so a tone adjustment over it touches ~2.5
 * million pixels, which is far too slow to keep up with a slider being dragged.
 * The preview works from a downscaled copy and the save re-renders at full
 * resolution, so the user gets a responsive control and the stored result loses
 * nothing.
 */
export const PREVIEW_MAX_LONG_EDGE = 900

/**
 * Rescale geometric steps for a preview of a different size.
 *
 * Every geometric operation has to move by the SAME factor or the pipeline
 * stops composing: a crop's coordinates are relative to whatever the previous
 * step produced, so scaling the crop but not the resize before it selects the
 * wrong region. Rotation, flipping and tone adjustments are scale-free and pass
 * through untouched.
 */
export function scaleOperations(operations: readonly LocalEntry[], factor: number): LocalEntry[] {
  if (factor === 1) return [...operations]
  return operations.map((operation) => {
    switch (operation.kind) {
      case "crop":
        return {
          ...operation,
          rect: {
            x: Math.round(operation.rect.x * factor),
            y: Math.round(operation.rect.y * factor),
            width: Math.max(1, Math.round(operation.rect.width * factor)),
            height: Math.max(1, Math.round(operation.rect.height * factor)),
          },
        }
      case "resize":
        return {
          ...operation,
          width: Math.max(1, Math.round(operation.width * factor)),
          height: Math.max(1, Math.round(operation.height * factor)),
        }
      default:
        return operation
    }
  })
}

/** Factor that fits `size` inside `maxLongEdge`, never above 1. */
export function previewScaleFor(
  size: { width: number; height: number },
  maxLongEdge: number = PREVIEW_MAX_LONG_EDGE
): number {
  const longEdge = Math.max(size.width, size.height)
  return longEdge <= maxLongEdge ? 1 : maxLongEdge / longEdge
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

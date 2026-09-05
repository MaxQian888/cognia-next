/**
 * Brush selections, and the one place the mask convention is decided.
 *
 * Two conventions are in play and they are opposites, which is exactly why this
 * lives in its own module with its own tests.
 *
 * Inside the app a mask is a greyscale image where WHITE means "edit here" and
 * BLACK means "keep". That is the convention the workbench paints in and the
 * one the overlay renders, because a bright brush over the region you are about
 * to change is what a user expects to see.
 *
 * At the provider boundary the convention flips. `images.edit` hands the mask
 * to the AI SDK, which passes it to the OpenAI images/edits endpoint unchanged,
 * and that endpoint reads FULLY TRANSPARENT pixels as the region to edit.
 * `maskToProviderBuffer` performs that inversion, and it is the only function
 * allowed to. Getting this backwards does not fail loudly: the provider happily
 * edits the complement of the selection and returns a plausible image, so the
 * bug reaches the user as "the AI changed the wrong part of my photo".
 */

import { createPixelBuffer, type PixelBuffer } from "./pixel-buffer"
import type { Size } from "./geometry"

export interface MaskPoint {
  x: number
  y: number
}

export interface MaskStroke {
  /** Painting adds to the selection, erasing takes away from it. */
  mode: "add" | "subtract"
  /** Brush radius in SOURCE pixels, already unscaled from the preview. */
  radius: number
  /** 0 is a fully feathered edge, 1 is a hard one. */
  hardness: number
  points: MaskPoint[]
}

/** Brush radius bounds offered by the UI, in source pixels. */
export const MIN_BRUSH_RADIUS = 2
export const MAX_BRUSH_RADIUS = 256

/**
 * Coverage in 0..255 per pixel, before it is expanded into RGBA.
 *
 * Kept as its own single-channel pass because a brush stroke touches the same
 * pixel many times (every stamp along the segment), and doing that four times
 * over in RGBA would be four times the work for three redundant copies.
 */
export function rasterizeCoverage(strokes: readonly MaskStroke[], size: Size): Uint8ClampedArray {
  const width = Math.max(1, Math.floor(size.width))
  const height = Math.max(1, Math.floor(size.height))
  const coverage = new Uint8ClampedArray(width * height)

  for (const stroke of strokes) {
    const radius = Math.max(MIN_BRUSH_RADIUS, Math.min(MAX_BRUSH_RADIUS, stroke.radius))
    const inner = radius * Math.max(0, Math.min(1, stroke.hardness))
    const falloff = Math.max(0.0001, radius - inner)
    const adding = stroke.mode === "add"

    for (const point of stampPoints(stroke.points, radius)) {
      const minX = Math.max(0, Math.floor(point.x - radius))
      const maxX = Math.min(width - 1, Math.ceil(point.x + radius))
      const minY = Math.max(0, Math.floor(point.y - radius))
      const maxY = Math.min(height - 1, Math.ceil(point.y + radius))

      for (let y = minY; y <= maxY; y += 1) {
        const dy = y + 0.5 - point.y
        for (let x = minX; x <= maxX; x += 1) {
          const dx = x + 0.5 - point.x
          const distance = Math.sqrt(dx * dx + dy * dy)
          if (distance > radius) continue
          const strength = distance <= inner ? 1 : 1 - (distance - inner) / falloff
          if (strength <= 0) continue
          const index = y * width + x
          const value = strength * 255
          if (adding) {
            if (value > coverage[index]) coverage[index] = value
          } else {
            const reduced = coverage[index] - value
            coverage[index] = reduced < 0 ? 0 : reduced
          }
        }
      }
    }
  }
  return coverage
}

/**
 * Interpolate a pointer path into overlapping stamps.
 *
 * A pointer move at speed reports positions tens of pixels apart, so stamping
 * only the reported points paints a dotted line. Spacing at a quarter of the
 * radius keeps consecutive stamps overlapping enough that the union reads as a
 * continuous stroke without paying for a stamp per pixel.
 */
function stampPoints(points: readonly MaskPoint[], radius: number): MaskPoint[] {
  if (points.length === 0) return []
  const spacing = Math.max(1, radius / 4)
  const stamps: MaskPoint[] = [points[0]]

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1]
    const to = points[i]
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const steps = Math.ceil(distance / spacing)
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps
      stamps.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
  }
  return stamps
}

/**
 * The in-app mask: opaque greyscale, white where the selection is.
 *
 * Opaque on purpose. This buffer is also what the overlay draws, and a mask
 * whose unselected area were transparent would be invisible over a dark image.
 */
export function rasterizeMask(strokes: readonly MaskStroke[], size: Size): PixelBuffer {
  const coverage = rasterizeCoverage(strokes, size)
  const mask = createPixelBuffer(size.width, size.height)
  for (let i = 0; i < coverage.length; i += 1) {
    const value = coverage[i]
    const offset = i * 4
    mask.data[offset] = value
    mask.data[offset + 1] = value
    mask.data[offset + 2] = value
    mask.data[offset + 3] = 255
  }
  return mask
}

/** Whether any pixel is selected at all. A blank mask must never be sent. */
export function isMaskEmpty(mask: PixelBuffer): boolean {
  for (let i = 0; i < mask.data.length; i += 4) {
    if (mask.data[i] > 0) return false
  }
  return true
}

/**
 * Invert the in-app mask into the shape the provider expects: the selected
 * region becomes fully transparent, everything else stays opaque black.
 *
 * Coverage is thresholded rather than carried through as partial alpha. The
 * endpoint documents a binary read of the alpha channel, so a feathered brush
 * edge would be resolved by the provider in a way we cannot predict. Deciding
 * it here, at 50% coverage, keeps the result the same across providers.
 */
export function maskToProviderBuffer(mask: PixelBuffer): PixelBuffer {
  const out = createPixelBuffer(mask.width, mask.height)
  for (let i = 0; i < mask.data.length; i += 4) {
    const selected = mask.data[i] >= 128
    out.data[i] = 0
    out.data[i + 1] = 0
    out.data[i + 2] = 0
    out.data[i + 3] = selected ? 0 : 255
  }
  return out
}

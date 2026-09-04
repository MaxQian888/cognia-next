/**
 * Rect and dimension maths for the crop and resize tools.
 *
 * Split out from `transform.ts` because it moves numbers, not pixels. The crop
 * overlay drags rects around on every pointer move, so this is the code that
 * runs hundreds of times a second, and keeping it free of any buffer means the
 * interaction can be unit-tested without decoding an image.
 */

import type { CropRect } from "./transform"

export interface Size {
  width: number
  height: number
}

/** `null` ratio means free-form: the user drags whatever shape they want. */
export interface AspectPreset {
  id: string
  ratio: number | null
}

/**
 * The presets the workbench offers. Square plus the two orientations of the
 * two ratios that actually matter downstream: 4:3 for documents and slides,
 * 16:9 for anything that will end up in a video or a screen capture.
 */
export const ASPECT_PRESETS: readonly AspectPreset[] = [
  { id: "free", ratio: null },
  { id: "square", ratio: 1 },
  { id: "landscape4x3", ratio: 4 / 3 },
  { id: "portrait3x4", ratio: 3 / 4 },
  { id: "landscape16x9", ratio: 16 / 9 },
  { id: "portrait9x16", ratio: 9 / 16 },
] as const

/** Smallest crop the UI will produce, in source pixels. */
export const MIN_CROP_EDGE = 16

/**
 * Push `rect` back inside `bounds` without changing its size when that is
 * possible, and shrink it only when it genuinely does not fit.
 *
 * Translating before shrinking is what makes dragging a crop box against an
 * edge feel right: the box slides along the edge instead of collapsing.
 */
export function clampCropRect(rect: CropRect, bounds: Size): CropRect {
  const width = Math.max(1, Math.min(Math.round(rect.width), bounds.width))
  const height = Math.max(1, Math.min(Math.round(rect.height), bounds.height))
  const x = Math.max(0, Math.min(Math.round(rect.x), bounds.width - width))
  const y = Math.max(0, Math.min(Math.round(rect.y), bounds.height - height))
  return { x, y, width, height }
}

/**
 * The largest rect of `ratio` that fits `bounds`, centred.
 *
 * This is what selecting an aspect preset with no prior crop produces, and the
 * fallback whenever reshaping an existing rect cannot honour the ratio.
 */
export function largestRectForAspect(bounds: Size, ratio: number): CropRect {
  const boundsRatio = bounds.width / bounds.height
  const width = ratio > boundsRatio ? bounds.width : Math.round(bounds.height * ratio)
  const height = ratio > boundsRatio ? Math.round(bounds.width / ratio) : bounds.height
  return clampCropRect(
    {
      x: Math.round((bounds.width - width) / 2),
      y: Math.round((bounds.height - height) / 2),
      width,
      height,
    },
    bounds
  )
}

/**
 * Reshape `rect` to `ratio` while keeping its centre and staying inside
 * `bounds`. A `null` ratio just clamps, which is the free-form case.
 *
 * Area is preserved rather than one edge, so switching between 16:9 and 9:16
 * does not shrink the selection a little further each time.
 */
export function applyAspectToRect(rect: CropRect, ratio: number | null, bounds: Size): CropRect {
  if (ratio === null) return clampCropRect(rect, bounds)

  const area = Math.max(rect.width * rect.height, MIN_CROP_EDGE * MIN_CROP_EDGE)
  let width = Math.round(Math.sqrt(area * ratio))
  let height = Math.round(width / ratio)

  if (width > bounds.width) {
    width = bounds.width
    height = Math.round(width / ratio)
  }
  if (height > bounds.height) {
    height = bounds.height
    width = Math.round(height * ratio)
  }
  if (width < MIN_CROP_EDGE || height < MIN_CROP_EDGE) {
    return largestRectForAspect(bounds, ratio)
  }

  const centreX = rect.x + rect.width / 2
  const centreY = rect.y + rect.height / 2
  return clampCropRect(
    { x: Math.round(centreX - width / 2), y: Math.round(centreY - height / 2), width, height },
    bounds
  )
}

/** Whether a rect selects the whole frame, meaning cropping is a no-op. */
export function isFullFrame(rect: CropRect, bounds: Size): boolean {
  return (
    Math.round(rect.x) === 0 &&
    Math.round(rect.y) === 0 &&
    Math.round(rect.width) === bounds.width &&
    Math.round(rect.height) === bounds.height
  )
}

/**
 * Resolve a width/height edit from the resize panel.
 *
 * When the lock is on, whichever field the user touched wins and the other
 * follows from the source aspect, which is the behaviour every image editor
 * has. `edited` says which one they touched, because with the lock on the two
 * fields cannot both be authoritative.
 */
export function resolveResize(
  source: Size,
  next: Partial<Size>,
  { lockAspect, edited }: { lockAspect: boolean; edited: "width" | "height" }
): Size {
  const aspect = source.width / source.height
  const width = Math.max(1, Math.round(next.width ?? source.width))
  const height = Math.max(1, Math.round(next.height ?? source.height))
  if (!lockAspect) return { width, height }
  return edited === "width"
    ? { width, height: Math.max(1, Math.round(width / aspect)) }
    : { width: Math.max(1, Math.round(height * aspect)), height }
}

/**
 * Map a rect expressed in displayed (zoomed, letterboxed) coordinates back to
 * source pixels.
 *
 * The crop overlay lives on top of an `object-contain` image, so its
 * coordinates are in CSS pixels of the displayed box and carry the letterbox
 * offset. Getting this wrong is the classic crop bug where the saved region is
 * offset from the one the user drew, so it lives here with a test rather than
 * inline in a pointer handler.
 */
export function displayRectToSource(rect: CropRect, displayed: Size, source: Size): CropRect {
  const scaleX = source.width / Math.max(1, displayed.width)
  const scaleY = source.height / Math.max(1, displayed.height)
  return clampCropRect(
    {
      x: rect.x * scaleX,
      y: rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    },
    source
  )
}

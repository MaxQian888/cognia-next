/**
 * Coordinate scaling for Anthropic Computer Use API constraints.
 *
 * The API constrains images to a max of 1568 px on the long edge and
 * ~1.15 megapixels total. For Claude Opus 4.7, the constraint relaxes to
 * 2576 px on the long edge with 1:1 pixel coordinates (no scaling).
 *
 * For pre-4.7 models, the backend must:
 *   1. Capture the real screen (e.g. 1920×1080)
 *   2. Downscale to the API constraint (e.g. 1330×864)
 *   3. Pass the downscaled image to the model
 *   4. When the model returns click coordinates in downscaled space,
 *      scale them back up to real screen coordinates before executing
 *
 * Reference: Anthropic Computer use tool docs §"Handle coordinate scaling
 * for higher resolutions".
 */

const MAX_LONG_EDGE_LEGACY = 1568
const MAX_TOTAL_PIXELS_LEGACY = 1_150_000
const MAX_LONG_EDGE_OPUS_4_7 = 2_576

export type ModelClass = "legacy" | "opus-4-7"

export function getScaleFactor(
  width: number,
  height: number,
  modelClass: ModelClass = "legacy"
): number {
  const longEdge = Math.max(width, height)
  if (modelClass === "opus-4-7") {
    // Opus 4.7 supports up to 2576 px on the long edge with 1:1 coordinates.
    if (longEdge <= MAX_LONG_EDGE_OPUS_4_7) return 1.0
    return MAX_LONG_EDGE_OPUS_4_7 / longEdge
  }
  // Legacy: must respect both long-edge and total-pixel constraints.
  const totalPixels = width * height
  const longEdgeScale = MAX_LONG_EDGE_LEGACY / longEdge
  const totalPixelsScale = Math.sqrt(MAX_TOTAL_PIXELS_LEGACY / totalPixels)
  return Math.min(1.0, longEdgeScale, totalPixelsScale)
}

export interface ScaledDisplay {
  realWidth: number
  realHeight: number
  scaledWidth: number
  scaledHeight: number
  scaleFactor: number
}

export function computeScaledDisplay(
  realWidth: number,
  realHeight: number,
  modelClass: ModelClass = "legacy"
): ScaledDisplay {
  const scaleFactor = getScaleFactor(realWidth, realHeight, modelClass)
  return {
    realWidth,
    realHeight,
    scaledWidth: Math.floor(realWidth * scaleFactor),
    scaledHeight: Math.floor(realHeight * scaleFactor),
    scaleFactor,
  }
}

/** Map a model-emitted coordinate back to the real-screen coordinate. */
export function unscaleCoordinate(
  scaled: { x: number; y: number },
  scaleFactor: number
): { x: number; y: number } {
  return {
    x: Math.round(scaled.x / scaleFactor),
    y: Math.round(scaled.y / scaleFactor),
  }
}

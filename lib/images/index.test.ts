/**
 * The barrel is the engine's shared surface, imported by the chat workbench,
 * its hook and the plugin Media API's delegation.
 *
 * Pinning the name list is what turns "this export lost its last caller" into
 * a failing test in the module that caused it, rather than a slow accumulation
 * of exports nothing uses. It is NOT protecting a published package boundary:
 * nothing outside the app tree imports `lib/images`.
 */

import * as engine from "./index"

const EXPECTED_EXPORTS = [
  // pixel-buffer
  "clonePixelBuffer",
  "createPixelBuffer",
  "hasTransparency",
  "pixelCount",
  "premultiply",
  "unpremultiply",
  // color
  "clamp01",
  "clampByte",
  "hslToRgb",
  "luma",
  "rgbToHsl",
  // adjust
  "applyAdjustments",
  "blurRadiusFor",
  "boxBlur",
  "isNeutral",
  "unsharpMask",
  "MAX_BLUR_RADIUS",
  "NEUTRAL_ADJUSTMENTS",
  // transform
  "cropBuffer",
  "flipBuffer",
  "resizeBuffer",
  "rotateBuffer",
  "rotateQuarterTurns",
  "transformBuffer",
  // geometry
  "applyAspectToRect",
  "clampCropRect",
  "displayPointToSource",
  "isFullFrame",
  "largestRectForAspect",
  "resolveResize",
  "ASPECT_PRESETS",
  "MIN_CROP_EDGE",
  // mask
  "isMaskEmpty",
  "maskToProviderBuffer",
  "rasterizeCoverage",
  "rasterizeMask",
  "MAX_BRUSH_RADIUS",
  "MIN_BRUSH_RADIUS",
  // codec
  "canRasterize",
  "chooseEncodeFormat",
  "decodeBlobToPixelBuffer",
  "decodeUrlToPixelBuffer",
  "encodePixelBuffer",
  "encodeProviderMask",
  "fromImageData",
  "pixelBufferToBlob",
  "pixelBufferToDataUrlSync",
  "toImageData",
  "ImageDecodeError",
  "DEFAULT_ENCODE_QUALITY",
  "IMAGE_ENCODE_FORMATS",
].sort()

describe("lib/images barrel", () => {
  it("publishes exactly the documented surface", () => {
    expect(Object.keys(engine).sort()).toEqual(EXPECTED_EXPORTS)
  })

  it("re-exports live bindings, not undefined placeholders", () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(engine[name as keyof typeof engine]).toBeDefined()
    }
  })

  it("composes end to end through the barrel alone", () => {
    // A crop, a rotate and an adjustment chained the way the workbench chains
    // them, proving the pieces line up on the same buffer shape.
    const source = engine.createPixelBuffer(4, 2)
    source.data.fill(120)
    const cropped = engine.cropBuffer(source, { x: 0, y: 0, width: 2, height: 2 })
    const rotated = engine.rotateQuarterTurns(cropped, 1)
    const adjusted = engine.applyAdjustments(rotated, { brightness: 10 })
    expect(adjusted).toMatchObject({ width: 2, height: 2 })
    expect(adjusted.data[0]).toBeGreaterThan(120)
  })
})

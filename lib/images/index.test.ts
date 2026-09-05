/**
 * The barrel is the engine's published surface. Two shells and the plugin Media
 * API import from it, so a rename that drops an export is a runtime `undefined`
 * in a `plugins/` bundle long before anyone notices in the app. Pinning the
 * name list turns that into a failing test in the module that caused it.
 */

import * as engine from "./index"

const EXPECTED_EXPORTS = [
  // pixel-buffer
  "clonePixelBuffer",
  "createPixelBuffer",
  "hasTransparency",
  "pixelCount",
  "pixelIndex",
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
  "displayRectToSource",
  "isFullFrame",
  "largestRectForAspect",
  "resolveResize",
  "ASPECT_PRESETS",
  "MIN_CROP_EDGE",
  // mask
  "isMaskEmpty",
  "maskCoverageRatio",
  "maskToProviderBuffer",
  "rasterizeCoverage",
  "rasterizeMask",
  "MAX_BRUSH_RADIUS",
  "MIN_BRUSH_RADIUS",
  // codec
  "canRasterize",
  "chooseEncodeFormat",
  "decodeBlobToPixelBuffer",
  "decodeToPixelBuffer",
  "decodeUrlToPixelBuffer",
  "encodePixelBuffer",
  "encodeProviderMask",
  "fromImageData",
  "pixelBufferToBlob",
  "pixelBufferToDataUrl",
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

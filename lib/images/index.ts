/**
 * One image engine, shared by the chat editing workbench and the plugin Media
 * API.
 *
 * Before this module the two surfaces each had their own half-implementation:
 * the plugin API carried canvas helpers that advertised eleven adjustments and
 * applied four, and the chat renderer had no pixel access at all. Anything that
 * decodes, crops, resizes, transforms, adjusts, masks or encodes an image in
 * this app goes through here, so the same slider produces the same bytes
 * everywhere.
 */

export {
  createPixelBuffer,
  clonePixelBuffer,
  hasTransparency,
  pixelCount,
  premultiply,
  unpremultiply,
  type PixelBuffer,
} from "./pixel-buffer"

export { clamp01, clampByte, hslToRgb, luma, rgbToHsl } from "./color"

export {
  applyAdjustments,
  blurRadiusFor,
  boxBlur,
  isNeutral,
  unsharpMask,
  MAX_BLUR_RADIUS,
  NEUTRAL_ADJUSTMENTS,
  type ImageAdjustments,
} from "./adjust"

export {
  cropBuffer,
  flipBuffer,
  resizeBuffer,
  rotateBuffer,
  rotateQuarterTurns,
  transformBuffer,
  type CropRect,
  type FlipOptions,
  type TransformOptions,
} from "./transform"

export {
  applyAspectToRect,
  clampCropRect,
  displayPointToSource,
  isFullFrame,
  largestRectForAspect,
  resolveResize,
  ASPECT_PRESETS,
  MIN_CROP_EDGE,
  type AspectPreset,
  type Size,
} from "./geometry"

export {
  isMaskEmpty,
  maskToProviderBuffer,
  rasterizeCoverage,
  rasterizeMask,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  type MaskPoint,
  type MaskStroke,
} from "./mask"

export {
  canRasterize,
  chooseEncodeFormat,
  decodeBlobToPixelBuffer,
  decodeUrlToPixelBuffer,
  encodePixelBuffer,
  encodeProviderMask,
  fromImageData,
  pixelBufferToBlob,
  pixelBufferToDataUrlSync,
  toImageData,
  ImageDecodeError,
  DEFAULT_ENCODE_QUALITY,
  IMAGE_ENCODE_FORMATS,
  type EncodedImage,
  type ImageDecodeFailureReason,
  type ImageEncodeFormat,
} from "./codec"

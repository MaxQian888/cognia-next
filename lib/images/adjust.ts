/**
 * The tone and spatial adjustments the workbench sliders drive.
 *
 * The plugin Media API has advertised eleven adjustments since it shipped, but
 * only four of them (brightness, contrast, saturation, hue) were ever
 * implemented. Exposure, gamma, vibrance, temperature, tint, blur and sharpen
 * were accepted and silently discarded. This module implements all eleven, and
 * `lib/plugin/api/media-api.ts` now delegates here, so the plugin surface stops
 * lying and the chat workbench gets the same pixels for the same slider.
 *
 * Every function is pure and operates on a `PixelBuffer`, which keeps the whole
 * file testable in the fast `node` Jest project with no canvas anywhere.
 *
 * Alpha is never touched by a tone adjustment. Only `blur` moves it, because
 * blurring an image without blurring its transparency produces a hard cutout
 * inside a soft frame.
 */

import { clamp01, clampByte, hslToRgb, luma, rgbToHsl } from "./color"
import {
  clonePixelBuffer,
  createPixelBuffer,
  premultiply,
  unpremultiply,
  type PixelBuffer,
} from "./pixel-buffer"

export interface ImageAdjustments {
  /** -100..100, additive channel offset. */
  brightness?: number
  /** -100..100, scales distance from mid grey. -100 is a flat grey field. */
  contrast?: number
  /** -100..100, read as plus or minus two stops of linear gain. */
  exposure?: number
  /** -100..100, scales distance from luma. */
  saturation?: number
  /** -100..100, saturation boost weighted toward already-dull pixels. */
  vibrance?: number
  /** -100 (cool) to 100 (warm), trades blue against red. */
  temperature?: number
  /** -100 (green) to 100 (magenta). */
  tint?: number
  /** -180..180 degrees of hue rotation. */
  hue?: number
  /** 0.1..10, standard display gamma. 1 is a no-op. */
  gamma?: number
  /** 0..100, mapped to a 0..24px blur radius. */
  blur?: number
  /** 0..100, unsharp-mask amount. */
  sharpen?: number
}

/** Every slider at its no-op value. Also the reset target for the UI. */
export const NEUTRAL_ADJUSTMENTS: Required<ImageAdjustments> = {
  brightness: 0,
  contrast: 0,
  exposure: 0,
  saturation: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  hue: 0,
  gamma: 1,
  blur: 0,
  sharpen: 0,
}

/** Largest blur radius in pixels, reached at `blur: 100`. */
export const MAX_BLUR_RADIUS = 24

/** True when nothing in `adjustments` would change a single pixel. */
export function isNeutral(adjustments: ImageAdjustments): boolean {
  return (Object.keys(NEUTRAL_ADJUSTMENTS) as Array<keyof ImageAdjustments>).every((key) => {
    const value = adjustments[key]
    return value === undefined || value === NEUTRAL_ADJUSTMENTS[key]
  })
}

/**
 * Apply every requested adjustment and return a new buffer.
 *
 * Order is fixed and deliberate, because these operations do not commute:
 * scene-referred gain (exposure) first, then display-referred level moves
 * (brightness, contrast, gamma), then white balance, then the chroma family,
 * and finally the two spatial convolutions. Sharpening before blurring, for
 * instance, would simply throw the sharpening away.
 */
export function applyAdjustments(buffer: PixelBuffer, adjustments: ImageAdjustments): PixelBuffer {
  if (isNeutral(adjustments)) return clonePixelBuffer(buffer)

  const {
    brightness = 0,
    contrast = 0,
    exposure = 0,
    saturation = 0,
    vibrance = 0,
    temperature = 0,
    tint = 0,
    hue = 0,
    gamma = 1,
    blur = 0,
    sharpen = 0,
  } = adjustments

  let result = applyToneAdjustments(buffer, {
    brightness,
    contrast,
    exposure,
    saturation,
    vibrance,
    temperature,
    tint,
    hue,
    gamma,
  })

  if (blur > 0) {
    result = boxBlur(result, blurRadiusFor(blur))
  }
  if (sharpen > 0) {
    result = unsharpMask(result, sharpen / 100)
  }
  return result
}

/** `blur` slider (0..100) to a pixel radius. */
export function blurRadiusFor(blur: number): number {
  return Math.max(0, Math.round((Math.min(100, blur) / 100) * MAX_BLUR_RADIUS))
}

type ToneAdjustments = Required<Omit<ImageAdjustments, "blur" | "sharpen">>

function applyToneAdjustments(buffer: PixelBuffer, tone: ToneAdjustments): PixelBuffer {
  const out = clonePixelBuffer(buffer)
  const { data } = out

  // Precompute everything that does not vary per pixel. The inner loop runs
  // over ~2.5M pixels for a canonical 1568px frame, so a `Math.pow` hoisted out
  // of it is worth the extra lines.
  const exposureGain = tone.exposure === 0 ? 1 : Math.pow(2, tone.exposure / 50)
  const brightnessOffset = tone.brightness * 2.55
  // `1 + contrast/100`, so -100 flattens the frame to mid grey and +100
  // doubles the distance from it. The formula the plugin Media API shipped with
  // fed a 0..2 scale into a curve that expects -255..255, which drove the
  // factor NEGATIVE past about +40: the image inverted and then clipped to pure
  // black and white. Delegating that here would have carried the bug into the
  // chat workbench, so the mapping is the linear one instead.
  const contrastFactor = 1 + tone.contrast / 100
  const gammaExponent = tone.gamma > 0 ? 1 / tone.gamma : 1
  const applyGamma = tone.gamma !== 1 && tone.gamma > 0
  const warmth = tone.temperature * 0.6
  const tintShift = tone.tint * 0.6
  const saturationScale = (tone.saturation + 100) / 100
  const vibranceAmount = tone.vibrance / 100
  const hueShift = tone.hue / 360

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]
    let g = data[i + 1]
    let b = data[i + 2]

    if (exposureGain !== 1) {
      r = clampByte(r * exposureGain)
      g = clampByte(g * exposureGain)
      b = clampByte(b * exposureGain)
    }

    if (brightnessOffset !== 0) {
      r = clampByte(r + brightnessOffset)
      g = clampByte(g + brightnessOffset)
      b = clampByte(b + brightnessOffset)
    }

    if (contrastFactor !== 1) {
      r = clampByte(contrastFactor * (r - 128) + 128)
      g = clampByte(contrastFactor * (g - 128) + 128)
      b = clampByte(contrastFactor * (b - 128) + 128)
    }

    if (applyGamma) {
      r = clampByte(255 * Math.pow(r / 255, gammaExponent))
      g = clampByte(255 * Math.pow(g / 255, gammaExponent))
      b = clampByte(255 * Math.pow(b / 255, gammaExponent))
    }

    // White balance. Temperature trades the blue channel against red. Tint
    // moves green against the red and blue pair, which is the magenta axis.
    if (warmth !== 0) {
      r = clampByte(r + warmth)
      b = clampByte(b - warmth)
    }
    if (tintShift !== 0) {
      g = clampByte(g - tintShift)
    }

    if (saturationScale !== 1) {
      const grey = luma(r, g, b)
      r = clampByte(grey + saturationScale * (r - grey))
      g = clampByte(grey + saturationScale * (g - grey))
      b = clampByte(grey + saturationScale * (b - grey))
    }

    if (vibranceAmount !== 0) {
      const [h, s, l] = rgbToHsl(r, g, b)
      // Scaling saturation by `1 + amount * (1 - s)` gives a dull pixel a much
      // larger relative lift than an already-vivid one, and leaves a true grey
      // (s === 0) grey. An additive lift would invent a red cast in every
      // neutral pixel, because grey has no meaningful hue to saturate toward.
      const boosted = clamp01(s * (1 + vibranceAmount * (1 - s)))
      const [vr, vg, vb] = hslToRgb(h, boosted, l)
      r = vr
      g = vg
      b = vb
    }

    if (hueShift !== 0) {
      const [h, s, l] = rgbToHsl(r, g, b)
      const [hr, hg, hb] = hslToRgb((h + hueShift + 1) % 1, s, l)
      r = hr
      g = hg
      b = hb
    }

    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
  }

  return out
}

/**
 * Separable box blur, three passes, which converges on a Gaussian closely
 * enough for a preview slider at a fraction of the cost.
 *
 * Colour is premultiplied by alpha before blurring and divided back out after.
 * Without that, a transparent pixel's undefined RGB bleeds into its opaque
 * neighbours and every soft edge picks up a dark halo.
 */
export function boxBlur(buffer: PixelBuffer, radius: number): PixelBuffer {
  if (radius <= 0) return clonePixelBuffer(buffer)

  const { width, height } = buffer
  const current = premultiply(buffer)
  const scratch = createPixelBuffer(width, height)

  for (let pass = 0; pass < 3; pass += 1) {
    boxBlurPass(current, scratch, radius, true)
    boxBlurPass(scratch, current, radius, false)
  }
  return unpremultiply(current)
}

/**
 * One axis of the box blur, using a running sum so each output pixel costs one
 * add and one subtract regardless of radius. Edges clamp to the border pixel,
 * which keeps the frame from darkening toward transparent.
 */
function boxBlurPass(
  source: PixelBuffer,
  target: PixelBuffer,
  radius: number,
  horizontal: boolean
): void {
  const { width, height } = source
  const lineLength = horizontal ? width : height
  const lineCount = horizontal ? height : width
  const window = radius * 2 + 1

  for (let line = 0; line < lineCount; line += 1) {
    const at = (position: number): number => {
      const clamped = position < 0 ? 0 : position >= lineLength ? lineLength - 1 : position
      return horizontal ? (line * width + clamped) * 4 : (clamped * width + line) * 4
    }

    let sumR = 0
    let sumG = 0
    let sumB = 0
    let sumA = 0
    for (let offset = -radius; offset <= radius; offset += 1) {
      const index = at(offset)
      sumR += source.data[index]
      sumG += source.data[index + 1]
      sumB += source.data[index + 2]
      sumA += source.data[index + 3]
    }

    for (let position = 0; position < lineLength; position += 1) {
      const out = at(position)
      target.data[out] = sumR / window
      target.data[out + 1] = sumG / window
      target.data[out + 2] = sumB / window
      target.data[out + 3] = sumA / window

      const leaving = at(position - radius)
      const entering = at(position + radius + 1)
      sumR += source.data[entering] - source.data[leaving]
      sumG += source.data[entering + 1] - source.data[leaving + 1]
      sumB += source.data[entering + 2] - source.data[leaving + 2]
      sumA += source.data[entering + 3] - source.data[leaving + 3]
    }
  }
}

/**
 * Unsharp mask: add back a scaled copy of the detail the blur removed.
 *
 * The blur radius is fixed at 1px. Sharpening is about local acutance, so the
 * slider controls how much detail is re-added, not how wide the halo is. A
 * radius-following slider produces the crunchy over-sharpened look instead.
 */
export function unsharpMask(buffer: PixelBuffer, amount: number): PixelBuffer {
  if (amount <= 0) return clonePixelBuffer(buffer)
  const blurred = boxBlur(buffer, 1)
  const out = clonePixelBuffer(buffer)
  const strength = amount * 1.5
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = clampByte(buffer.data[i] + strength * (buffer.data[i] - blurred.data[i]))
    out.data[i + 1] = clampByte(
      buffer.data[i + 1] + strength * (buffer.data[i + 1] - blurred.data[i + 1])
    )
    out.data[i + 2] = clampByte(
      buffer.data[i + 2] + strength * (buffer.data[i + 2] - blurred.data[i + 2])
    )
  }
  return out
}

/**
 * Tests for the Anthropic Computer Use coordinate scaling helpers.
 *
 * Reference numbers come from Anthropic's documented constraints:
 *   - legacy:    long edge ≤ 1568 px, total ≤ ~1.15 Mpx
 *   - opus-4-7:  long edge ≤ 2576 px, 1:1 below the limit (no scaling)
 */

import { computeScaledDisplay, getScaleFactor, unscaleCoordinate } from "./coordinates"

describe("getScaleFactor", () => {
  it("downscales 1920×1080 under the legacy total-pixels constraint", () => {
    const scale = getScaleFactor(1920, 1080, "legacy")
    // longEdgeScale = 1568 / 1920 ≈ 0.8167
    // totalPixelsScale = sqrt(1_150_000 / 2_073_600) ≈ 0.7447
    // min → ≈ 0.7447 (the total-pixels constraint wins)
    expect(scale).toBeLessThan(1.0)
    expect(scale).toBeGreaterThan(0)
    expect(scale).toBeCloseTo(0.7447, 2)
  })

  it("leaves 1024×768 unscaled under the legacy constraints", () => {
    // Both longEdgeScale (1568/1024 ≈ 1.53) and totalPixelsScale
    // (sqrt(1_150_000/786_432) ≈ 1.21) are above 1, so we cap at 1.0.
    expect(getScaleFactor(1024, 768, "legacy")).toBe(1.0)
  })

  it("leaves 2560×1440 unscaled under the opus-4-7 long-edge limit", () => {
    // longEdge = 2560 ≤ 2576, so scale = 1.0 (1:1 coordinates).
    expect(getScaleFactor(2560, 1440, "opus-4-7")).toBe(1.0)
  })

  it("scales 4096×2304 down to the opus-4-7 long-edge cap", () => {
    const scale = getScaleFactor(4096, 2304, "opus-4-7")
    // scale = 2576 / 4096 = 0.62890625
    expect(scale).toBeCloseTo(2576 / 4096, 6)
  })

  it("defaults to the legacy constraints when modelClass is omitted", () => {
    expect(getScaleFactor(1920, 1080)).toBe(getScaleFactor(1920, 1080, "legacy"))
  })

  it("returns 1.0 for orientation-flipped inputs that fit under all limits", () => {
    // Tall image — long edge is height, not width.
    expect(getScaleFactor(768, 1024, "legacy")).toBe(1.0)
  })
})

describe("computeScaledDisplay", () => {
  it("returns the original dimensions when no scaling is needed", () => {
    const result = computeScaledDisplay(1024, 768, "legacy")
    expect(result).toEqual({
      realWidth: 1024,
      realHeight: 768,
      scaledWidth: 1024,
      scaledHeight: 768,
      scaleFactor: 1.0,
    })
  })

  it("floors the scaled dimensions for 1920×1080 legacy", () => {
    const result = computeScaledDisplay(1920, 1080, "legacy")
    expect(result.realWidth).toBe(1920)
    expect(result.realHeight).toBe(1080)
    expect(result.scaleFactor).toBeCloseTo(0.7447, 2)
    expect(result.scaledWidth).toBe(Math.floor(1920 * result.scaleFactor))
    expect(result.scaledHeight).toBe(Math.floor(1080 * result.scaleFactor))
    // Sanity: the scaled image stays under both legacy limits.
    expect(Math.max(result.scaledWidth, result.scaledHeight)).toBeLessThanOrEqual(1568)
    expect(result.scaledWidth * result.scaledHeight).toBeLessThanOrEqual(1_150_000)
  })

  it("keeps 2560×1440 at 1:1 for opus-4-7", () => {
    expect(computeScaledDisplay(2560, 1440, "opus-4-7")).toEqual({
      realWidth: 2560,
      realHeight: 1440,
      scaledWidth: 2560,
      scaledHeight: 1440,
      scaleFactor: 1.0,
    })
  })

  it("downscales 4096×2304 to the opus-4-7 long-edge cap", () => {
    const result = computeScaledDisplay(4096, 2304, "opus-4-7")
    expect(result.scaleFactor).toBeCloseTo(2576 / 4096, 6)
    // 4096 * (2576/4096) = 2576 exactly; floor preserves it.
    expect(result.scaledWidth).toBe(2576)
    expect(result.scaledHeight).toBe(Math.floor(2304 * (2576 / 4096)))
  })
})

describe("unscaleCoordinate", () => {
  it("inverts computeScaledDisplay for a model click on a 4096×2304 opus-4-7 capture", () => {
    const display = computeScaledDisplay(4096, 2304, "opus-4-7")
    const real = unscaleCoordinate({ x: 500, y: 300 }, display.scaleFactor)
    // 500 / (2576/4096) = 500 * 4096 / 2576 ≈ 794.72 → 795
    expect(real.x).toBe(Math.round(500 / display.scaleFactor))
    expect(real.y).toBe(Math.round(300 / display.scaleFactor))
    expect(real.x).toBe(795)
    expect(real.y).toBe(477)
  })

  it("is a no-op when the scale factor is 1", () => {
    expect(unscaleCoordinate({ x: 123, y: 456 }, 1)).toEqual({ x: 123, y: 456 })
  })

  it("rounds half values consistently", () => {
    // 1 / 0.5 = 2, 3 / 0.5 = 6 — clean integers, no rounding surprise.
    expect(unscaleCoordinate({ x: 1, y: 3 }, 0.5)).toEqual({ x: 2, y: 6 })
  })
})

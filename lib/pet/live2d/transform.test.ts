import { DEFAULT_LIVE2D_TRANSFORM } from "@/types/pet"
import { clamp, isDefaultTransform, normalizeTransform } from "./transform"

describe("clamp", () => {
  it("clamps both bounds and passes through in-range values", () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})

describe("normalizeTransform", () => {
  it("returns defaults for absent / null / empty input", () => {
    expect(normalizeTransform()).toEqual(DEFAULT_LIVE2D_TRANSFORM)
    expect(normalizeTransform(null)).toEqual(DEFAULT_LIVE2D_TRANSFORM)
    expect(normalizeTransform({})).toEqual(DEFAULT_LIVE2D_TRANSFORM)
  })

  it("passes through valid values", () => {
    expect(normalizeTransform({ scale: 1.4, offsetX: 0.1, offsetY: -0.2 })).toEqual({
      scale: 1.4,
      offsetX: 0.1,
      offsetY: -0.2,
    })
  })

  it("clamps out-of-range values", () => {
    expect(normalizeTransform({ scale: 9, offsetX: -3, offsetY: 3 })).toEqual({
      scale: 2,
      offsetX: -0.5,
      offsetY: 0.5,
    })
    expect(normalizeTransform({ scale: 0.01 }).scale).toBe(0.5)
  })

  it("replaces non-finite values with defaults", () => {
    expect(normalizeTransform({ scale: Number.NaN, offsetX: Infinity })).toEqual(
      DEFAULT_LIVE2D_TRANSFORM
    )
  })
})

describe("isDefaultTransform", () => {
  it("detects the neutral transform", () => {
    expect(isDefaultTransform({ scale: 1, offsetX: 0, offsetY: 0 })).toBe(true)
    expect(isDefaultTransform({ scale: 1.1, offsetX: 0, offsetY: 0 })).toBe(false)
  })
})

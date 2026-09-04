import { clamp01, clampByte, hslToRgb, luma, rgbToHsl } from "./color"

describe("clamping", () => {
  it("clamp01 holds the unit range", () => {
    expect(clamp01(-0.5)).toBe(0)
    expect(clamp01(0.25)).toBe(0.25)
    expect(clamp01(4)).toBe(1)
  })

  it("clampByte holds the byte range", () => {
    expect(clampByte(-30)).toBe(0)
    expect(clampByte(128.6)).toBe(128.6)
    expect(clampByte(900)).toBe(255)
  })
})

describe("luma", () => {
  it("uses Rec. 601 weights", () => {
    expect(luma(255, 0, 0)).toBeCloseTo(76.245, 3)
    expect(luma(0, 255, 0)).toBeCloseTo(149.685, 3)
    expect(luma(255, 255, 255)).toBeCloseTo(255, 3)
  })
})

describe("rgbToHsl", () => {
  it("reports zero saturation for grey", () => {
    const [h, s, l] = rgbToHsl(128, 128, 128)
    expect(h).toBe(0)
    expect(s).toBe(0)
    expect(l).toBeCloseTo(128 / 255, 5)
  })

  it("places the primaries on the expected hues", () => {
    expect(rgbToHsl(255, 0, 0)[0]).toBeCloseTo(0, 5)
    expect(rgbToHsl(0, 255, 0)[0]).toBeCloseTo(1 / 3, 5)
    expect(rgbToHsl(0, 0, 255)[0]).toBeCloseTo(2 / 3, 5)
  })
})

describe("hslToRgb", () => {
  it("round-trips the primaries and greys exactly", () => {
    for (const rgb of [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [17, 17, 17],
      [200, 130, 40],
    ]) {
      const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2])
      expect(hslToRgb(h, s, l)).toEqual(rgb)
    }
  })

  it("returns grey when saturation is zero, whatever the hue", () => {
    expect(hslToRgb(0.4, 0, 0.5)).toEqual([128, 128, 128])
  })
})

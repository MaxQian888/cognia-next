import {
  applyAdjustments,
  blurRadiusFor,
  boxBlur,
  isNeutral,
  unsharpMask,
  MAX_BLUR_RADIUS,
  NEUTRAL_ADJUSTMENTS,
} from "./adjust"
import { createPixelBuffer, type PixelBuffer } from "./pixel-buffer"

function solid(width: number, height: number, rgba: number[]): PixelBuffer {
  const buffer = createPixelBuffer(width, height)
  for (let i = 0; i < buffer.data.length; i += 4) {
    buffer.data[i] = rgba[0]
    buffer.data[i + 1] = rgba[1]
    buffer.data[i + 2] = rgba[2]
    buffer.data[i + 3] = rgba[3]
  }
  return buffer
}

function pixel(buffer: PixelBuffer, x: number, y: number): number[] {
  const at = (y * buffer.width + x) * 4
  return [buffer.data[at], buffer.data[at + 1], buffer.data[at + 2], buffer.data[at + 3]]
}

describe("isNeutral", () => {
  it("treats an empty object and the neutral constant as no-ops", () => {
    expect(isNeutral({})).toBe(true)
    expect(isNeutral(NEUTRAL_ADJUSTMENTS)).toBe(true)
  })

  it("catches every slider individually", () => {
    for (const key of Object.keys(NEUTRAL_ADJUSTMENTS) as Array<keyof typeof NEUTRAL_ADJUSTMENTS>) {
      const moved = { [key]: NEUTRAL_ADJUSTMENTS[key] + 1 }
      expect(isNeutral(moved)).toBe(false)
    }
  })
})

describe("applyAdjustments", () => {
  it("returns a detached copy when nothing is asked for", () => {
    const source = solid(2, 2, [10, 20, 30, 255])
    const result = applyAdjustments(source, {})
    expect(result).not.toBe(source)
    expect([...result.data]).toEqual([...source.data])
  })

  it("brightens additively and clamps at the ceiling", () => {
    expect(
      pixel(applyAdjustments(solid(1, 1, [100, 100, 100, 255]), { brightness: 20 }), 0, 0)
    ).toEqual([151, 151, 151, 255])
    expect(
      pixel(applyAdjustments(solid(1, 1, [250, 250, 250, 255]), { brightness: 100 }), 0, 0)
    ).toEqual([255, 255, 255, 255])
  })

  it("leaves alpha alone for every tone adjustment", () => {
    const source = solid(1, 1, [120, 90, 60, 77])
    const tone = {
      brightness: 30,
      contrast: 20,
      exposure: 25,
      saturation: -40,
      vibrance: 30,
      temperature: 40,
      tint: -20,
      hue: 90,
      gamma: 2.2,
    }
    expect(pixel(applyAdjustments(source, tone), 0, 0)[3]).toBe(77)
  })

  it("reads exposure as stops of linear gain", () => {
    // +50 is one stop, so mid grey doubles.
    expect(pixel(applyAdjustments(solid(1, 1, [64, 64, 64, 255]), { exposure: 50 }), 0, 0)).toEqual(
      [128, 128, 128, 255]
    )
  })

  it("applies gamma as a power curve that leaves the endpoints fixed", () => {
    const lifted = applyAdjustments(solid(1, 1, [64, 64, 64, 255]), { gamma: 2.2 })
    expect(lifted.data[0]).toBeGreaterThan(64)
    const white = applyAdjustments(solid(1, 1, [255, 255, 255, 255]), { gamma: 2.2 })
    expect(white.data[0]).toBe(255)
    const black = applyAdjustments(solid(1, 1, [0, 0, 0, 255]), { gamma: 2.2 })
    expect(black.data[0]).toBe(0)
  })

  it("pushes contrast away from mid grey in both directions", () => {
    const dark = applyAdjustments(solid(1, 1, [80, 80, 80, 255]), { contrast: 50 })
    const light = applyAdjustments(solid(1, 1, [180, 180, 180, 255]), { contrast: 50 })
    expect(dark.data[0]).toBeLessThan(80)
    expect(light.data[0]).toBeGreaterThan(180)
  })

  it("desaturates all the way to luma at -100", () => {
    const result = applyAdjustments(solid(1, 1, [200, 50, 20, 255]), { saturation: -100 })
    const [r, g, b] = pixel(result, 0, 0)
    expect(r).toBe(g)
    expect(g).toBe(b)
  })

  it("leaves a neutral grey neutral under vibrance", () => {
    // The whole point of the multiplicative form: an additive saturation lift
    // would give grey an arbitrary hue, which reads as a colour cast.
    const result = applyAdjustments(solid(1, 1, [128, 128, 128, 255]), { vibrance: 100 })
    expect(pixel(result, 0, 0)).toEqual([128, 128, 128, 255])
  })

  it("lifts a dull colour more than a vivid one under vibrance", () => {
    const dull = applyAdjustments(solid(1, 1, [140, 120, 120, 255]), { vibrance: 100 })
    const vivid = applyAdjustments(solid(1, 1, [255, 0, 0, 255]), { vibrance: 100 })
    const dullSpread = dull.data[0] - dull.data[1]
    expect(dullSpread).toBeGreaterThan(140 - 120)
    expect(pixel(vivid, 0, 0)).toEqual([255, 0, 0, 255])
  })

  it("warms toward red and cools toward blue", () => {
    const warm = applyAdjustments(solid(1, 1, [128, 128, 128, 255]), { temperature: 50 })
    expect(warm.data[0]).toBeGreaterThan(128)
    expect(warm.data[2]).toBeLessThan(128)
    const cool = applyAdjustments(solid(1, 1, [128, 128, 128, 255]), { temperature: -50 })
    expect(cool.data[0]).toBeLessThan(128)
    expect(cool.data[2]).toBeGreaterThan(128)
  })

  it("moves tint along the green and magenta axis only", () => {
    const magenta = applyAdjustments(solid(1, 1, [128, 128, 128, 255]), { tint: 50 })
    expect(magenta.data[1]).toBeLessThan(128)
    expect(magenta.data[0]).toBe(128)
    expect(magenta.data[2]).toBe(128)
  })

  it("rotates hue by the requested degrees", () => {
    const rotated = applyAdjustments(solid(1, 1, [255, 0, 0, 255]), { hue: 120 })
    expect(pixel(rotated, 0, 0)).toEqual([0, 255, 0, 255])
  })
})

describe("blurRadiusFor", () => {
  it("maps the slider onto the pixel radius", () => {
    expect(blurRadiusFor(0)).toBe(0)
    expect(blurRadiusFor(100)).toBe(MAX_BLUR_RADIUS)
    expect(blurRadiusFor(50)).toBe(Math.round(MAX_BLUR_RADIUS / 2))
    expect(blurRadiusFor(400)).toBe(MAX_BLUR_RADIUS)
  })
})

describe("boxBlur", () => {
  it("is a no-op at radius zero but still detaches", () => {
    const source = solid(3, 3, [10, 10, 10, 255])
    const result = boxBlur(source, 0)
    expect(result).not.toBe(source)
    expect([...result.data]).toEqual([...source.data])
  })

  it("spreads an isolated bright pixel into its neighbours", () => {
    const source = solid(5, 5, [0, 0, 0, 255])
    const centre = (2 * 5 + 2) * 4
    source.data[centre] = 255
    source.data[centre + 1] = 255
    source.data[centre + 2] = 255

    const blurred = boxBlur(source, 1)
    expect(pixel(blurred, 2, 2)[0]).toBeLessThan(255)
    expect(pixel(blurred, 1, 2)[0]).toBeGreaterThan(0)
    expect(pixel(blurred, 2, 1)[0]).toBeGreaterThan(0)
  })

  it("preserves a flat field rather than darkening it at the edges", () => {
    const blurred = boxBlur(solid(6, 6, [90, 90, 90, 255]), 2)
    for (let x = 0; x < 6; x += 1) {
      expect(pixel(blurred, x, 0)[0]).toBeCloseTo(90, -1)
    }
  })

  it("does not pull black out of transparent pixels into opaque ones", () => {
    // Premultiplied blur is the reason this holds. Without it the undefined RGB
    // behind a transparent pixel bleeds in and the edge picks up a dark halo.
    const source = createPixelBuffer(4, 1)
    for (let x = 0; x < 4; x += 1) {
      const at = x * 4
      source.data[at] = 255
      source.data[at + 1] = 255
      source.data[at + 2] = 255
      source.data[at + 3] = x < 2 ? 255 : 0
    }
    const blurred = boxBlur(source, 1)
    expect(pixel(blurred, 0, 0)[0]).toBeGreaterThan(240)
  })
})

describe("unsharpMask", () => {
  it("is a no-op at zero amount", () => {
    const source = solid(3, 3, [50, 60, 70, 255])
    expect([...unsharpMask(source, 0).data]).toEqual([...source.data])
  })

  it("increases the contrast across an edge", () => {
    const source = createPixelBuffer(6, 1)
    for (let x = 0; x < 6; x += 1) {
      const at = x * 4
      const value = x < 3 ? 80 : 180
      source.data[at] = value
      source.data[at + 1] = value
      source.data[at + 2] = value
      source.data[at + 3] = 255
    }
    const sharpened = unsharpMask(source, 1)
    expect(pixel(sharpened, 2, 0)[0]).toBeLessThan(80)
    expect(pixel(sharpened, 3, 0)[0]).toBeGreaterThan(180)
  })
})

describe("spatial adjustments through applyAdjustments", () => {
  // `boxBlur` and `unsharpMask` are covered directly above. These pin the
  // WIRING: that the slider values reach them at all, which is what was
  // missing for seven of the eleven controls before the engine existed.
  /** A hard vertical edge down the middle, which a blur has to soften. */
  function splitField(width: number, height: number): PixelBuffer {
    const buffer = createPixelBuffer(width, height)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4
        const value = x < width / 2 ? 255 : 0
        buffer.data[at] = value
        buffer.data[at + 1] = value
        buffer.data[at + 2] = value
        buffer.data[at + 3] = 255
      }
    }
    return buffer
  }

  it("routes the blur slider through the pixel radius mapping", () => {
    const source = splitField(40, 4)
    expect(pixel(applyAdjustments(source, {}), 21, 2)[0]).toBe(0)

    const gentle = applyAdjustments(source, { blur: 20 })
    const strong = applyAdjustments(source, { blur: 100 })
    expect(strong.data.length).toBe(source.data.length)
    // A larger slider value has to reach further past the edge.
    expect(pixel(strong, 26, 2)[0]).toBeGreaterThan(pixel(gentle, 26, 2)[0])
    expect(pixel(strong, 20, 2)[0]).toBeLessThan(255)
  })

  it("routes the sharpen slider through the unsharp mask", () => {
    const source = createPixelBuffer(6, 1)
    for (let x = 0; x < 6; x += 1) {
      const at = x * 4
      const value = x < 3 ? 80 : 180
      source.data[at] = value
      source.data[at + 1] = value
      source.data[at + 2] = value
      source.data[at + 3] = 255
    }
    const sharpened = applyAdjustments(source, { sharpen: 100 })
    expect(pixel(sharpened, 2, 0)[0]).toBeLessThan(80)
    expect(pixel(sharpened, 3, 0)[0]).toBeGreaterThan(180)
  })

  it("blurs before sharpening, so the blur is still visible in the result", () => {
    // Sharpening first would simply be thrown away by the blur that follows.
    const source = splitField(40, 4)
    const both = applyAdjustments(source, { blur: 60, sharpen: 60 })
    expect(pixel(both, 22, 2)[0]).toBeGreaterThan(0)
    expect(pixel(both, 18, 2)[0]).toBeLessThan(255)
  })
})

import { createPixelBuffer } from "./pixel-buffer"
import {
  isMaskEmpty,
  maskToProviderBuffer,
  rasterizeCoverage,
  rasterizeMask,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  type MaskStroke,
} from "./mask"

const SIZE = { width: 32, height: 32 }

function coverageAt(coverage: Uint8ClampedArray, x: number, y: number): number {
  return coverage[y * SIZE.width + x]
}

function stroke(overrides: Partial<MaskStroke> = {}): MaskStroke {
  return {
    mode: "add",
    radius: 6,
    hardness: 1,
    points: [{ x: 16, y: 16 }],
    ...overrides,
  }
}

describe("rasterizeCoverage", () => {
  it("returns an empty field for no strokes", () => {
    const coverage = rasterizeCoverage([], SIZE)
    expect(coverage).toHaveLength(SIZE.width * SIZE.height)
    expect([...coverage].every((value) => value === 0)).toBe(true)
  })

  it("paints a filled disc at the stamp", () => {
    const coverage = rasterizeCoverage([stroke()], SIZE)
    expect(coverageAt(coverage, 16, 16)).toBe(255)
    expect(coverageAt(coverage, 19, 16)).toBeGreaterThan(0)
    expect(coverageAt(coverage, 30, 16)).toBe(0)
  })

  it("feathers the edge when hardness is below one", () => {
    const hard = rasterizeCoverage([stroke({ hardness: 1 })], SIZE)
    const soft = rasterizeCoverage([stroke({ hardness: 0 })], SIZE)
    expect(coverageAt(hard, 21, 16)).toBeGreaterThan(coverageAt(soft, 21, 16))
    // A fully feathered brush peaks at the stamp position, which sits between
    // pixel centres, so its strongest pixel is near but not at full coverage.
    expect(coverageAt(soft, 16, 16)).toBeGreaterThan(200)
    expect(coverageAt(soft, 16, 16)).toBe(Math.max(...soft))
  })

  it("joins reported points into a continuous stroke", () => {
    // A fast drag reports widely spaced points. Stamping only those would leave
    // gaps between the discs, which reads as a dotted line.
    const coverage = rasterizeCoverage(
      [
        stroke({
          radius: 3,
          points: [
            { x: 4, y: 16 },
            { x: 28, y: 16 },
          ],
        }),
      ],
      SIZE
    )
    for (let x = 5; x <= 27; x += 1) {
      expect(coverageAt(coverage, x, 16)).toBeGreaterThan(0)
    }
  })

  it("subtracts a later stroke from an earlier one", () => {
    const coverage = rasterizeCoverage(
      [stroke({ radius: 12 }), stroke({ mode: "subtract", radius: 4 })],
      SIZE
    )
    expect(coverageAt(coverage, 16, 16)).toBe(0)
    expect(coverageAt(coverage, 16, 24)).toBeGreaterThan(0)
  })

  it("clamps the brush radius to the offered range", () => {
    const tiny = rasterizeCoverage([stroke({ radius: 0 })], SIZE)
    expect(coverageAt(tiny, 16, 16)).toBe(255)
    const huge = rasterizeCoverage([stroke({ radius: MAX_BRUSH_RADIUS * 10 })], {
      width: 8,
      height: 8,
    })
    expect(huge.some((value) => value > 0)).toBe(true)
    expect(MIN_BRUSH_RADIUS).toBeLessThan(MAX_BRUSH_RADIUS)
  })

  it("stays inside the frame when the brush hangs off an edge", () => {
    const coverage = rasterizeCoverage([stroke({ points: [{ x: 0, y: 0 }] })], SIZE)
    expect(coverageAt(coverage, 0, 0)).toBe(255)
    expect(coverageAt(coverage, 31, 31)).toBe(0)
  })
})

describe("rasterizeMask", () => {
  it("produces an opaque greyscale image, white where selected", () => {
    const mask = rasterizeMask([stroke()], SIZE)
    const centre = (16 * SIZE.width + 16) * 4
    expect([mask.data[centre], mask.data[centre + 1], mask.data[centre + 2]]).toEqual([
      255, 255, 255,
    ])
    expect(mask.data[centre + 3]).toBe(255)
    const corner = 0
    expect(mask.data[corner]).toBe(0)
    // Opaque everywhere, so the overlay is visible over a dark photo.
    expect(mask.data[corner + 3]).toBe(255)
  })
})

describe("isMaskEmpty", () => {
  it("is true for an untouched mask and false once anything is painted", () => {
    expect(isMaskEmpty(rasterizeMask([], SIZE))).toBe(true)
    expect(isMaskEmpty(rasterizeMask([stroke()], SIZE))).toBe(false)
  })
})

describe("maskToProviderBuffer", () => {
  it("inverts the in-app convention: the selection becomes transparent", () => {
    // This is the direction the OpenAI images/edits endpoint reads. Getting it
    // backwards edits the complement of the selection and still returns a
    // plausible image, so nothing downstream would catch it.
    const mask = rasterizeMask([stroke()], SIZE)
    const provider = maskToProviderBuffer(mask)
    const centre = (16 * SIZE.width + 16) * 4
    expect(provider.data[centre + 3]).toBe(0)
    expect(provider.data[3]).toBe(255)
  })

  it("thresholds feathered coverage rather than passing partial alpha on", () => {
    const mask = createPixelBuffer(2, 1)
    mask.data[0] = 200
    mask.data[3] = 255
    mask.data[4] = 60
    mask.data[7] = 255
    const provider = maskToProviderBuffer(mask)
    expect(provider.data[3]).toBe(0)
    expect(provider.data[7]).toBe(255)
  })

  it("keeps the unselected region opaque black", () => {
    const provider = maskToProviderBuffer(rasterizeMask([], SIZE))
    expect([...provider.data.slice(0, 4)]).toEqual([0, 0, 0, 255])
  })
})

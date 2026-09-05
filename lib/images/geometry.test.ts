import {
  applyAspectToRect,
  clampCropRect,
  displayPointToSource,
  isFullFrame,
  largestRectForAspect,
  resolveResize,
  ASPECT_PRESETS,
  MIN_CROP_EDGE,
} from "./geometry"

const BOUNDS = { width: 800, height: 600 }

describe("ASPECT_PRESETS", () => {
  it("offers free-form plus square and both orientations of 4:3 and 16:9", () => {
    expect(ASPECT_PRESETS.map((preset) => preset.id)).toEqual([
      "free",
      "square",
      "landscape4x3",
      "portrait3x4",
      "landscape16x9",
      "portrait9x16",
    ])
    expect(ASPECT_PRESETS[0].ratio).toBeNull()
  })

  it("gives every named preset a positive ratio", () => {
    for (const preset of ASPECT_PRESETS.slice(1)) {
      expect(preset.ratio).toBeGreaterThan(0)
    }
  })
})

describe("clampCropRect", () => {
  it("passes an interior rect through, rounded", () => {
    expect(clampCropRect({ x: 10.4, y: 20.6, width: 100.2, height: 50.5 }, BOUNDS)).toEqual({
      x: 10,
      y: 21,
      width: 100,
      height: 51,
    })
  })

  it("slides a rect back inside instead of shrinking it", () => {
    expect(clampCropRect({ x: 780, y: 0, width: 100, height: 100 }, BOUNDS)).toMatchObject({
      x: 700,
      width: 100,
    })
  })

  it("shrinks only when the rect genuinely cannot fit", () => {
    expect(clampCropRect({ x: 0, y: 0, width: 5000, height: 5000 }, BOUNDS)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })
  })

  it("clamps negative origins to the frame", () => {
    expect(clampCropRect({ x: -50, y: -50, width: 100, height: 100 }, BOUNDS)).toMatchObject({
      x: 0,
      y: 0,
    })
  })
})

describe("largestRectForAspect", () => {
  it("fills the width for a ratio wider than the frame", () => {
    const rect = largestRectForAspect(BOUNDS, 16 / 9)
    expect(rect.width).toBe(800)
    expect(rect.height).toBe(450)
    expect(rect.y).toBe(75)
  })

  it("fills the height for a ratio taller than the frame", () => {
    const rect = largestRectForAspect(BOUNDS, 9 / 16)
    expect(rect.height).toBe(600)
    expect(rect.width).toBe(338)
  })

  it("stays inside the frame for every preset", () => {
    for (const preset of ASPECT_PRESETS) {
      if (preset.ratio === null) continue
      const rect = largestRectForAspect(BOUNDS, preset.ratio)
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(BOUNDS.width)
      expect(rect.y + rect.height).toBeLessThanOrEqual(BOUNDS.height)
    }
  })
})

describe("applyAspectToRect", () => {
  it("only clamps for the free preset", () => {
    expect(applyAspectToRect({ x: 5, y: 5, width: 90, height: 40 }, null, BOUNDS)).toEqual({
      x: 5,
      y: 5,
      width: 90,
      height: 40,
    })
  })

  it("reshapes to the ratio while keeping the centre", () => {
    const rect = applyAspectToRect({ x: 100, y: 100, width: 200, height: 200 }, 2, BOUNDS)
    expect(rect.width / rect.height).toBeCloseTo(2, 1)
    // Within a pixel: the rect is rounded to integers, so a half-pixel drift
    // off the exact centre is the correct answer, not a miss.
    expect(Math.abs(rect.x + rect.width / 2 - 200)).toBeLessThanOrEqual(1)
    expect(Math.abs(rect.y + rect.height / 2 - 200)).toBeLessThanOrEqual(1)
  })

  it("preserves area so repeated flips do not shrink the selection", () => {
    let rect = { x: 100, y: 100, width: 320, height: 180 }
    const startArea = rect.width * rect.height
    for (let i = 0; i < 6; i += 1) {
      rect = applyAspectToRect(rect, i % 2 === 0 ? 9 / 16 : 16 / 9, BOUNDS)
    }
    expect(rect.width * rect.height).toBeGreaterThan(startArea * 0.9)
  })

  it("falls back to the largest fitting rect when the request would be too small", () => {
    const rect = applyAspectToRect({ x: 0, y: 0, width: 1, height: 1 }, 1, BOUNDS)
    expect(rect.width).toBeGreaterThanOrEqual(MIN_CROP_EDGE)
    expect(rect.height).toBeGreaterThanOrEqual(MIN_CROP_EDGE)
  })

  it("never leaves the frame even when the source rect is against an edge", () => {
    const rect = applyAspectToRect({ x: 760, y: 560, width: 40, height: 40 }, 16 / 9, BOUNDS)
    expect(rect.x + rect.width).toBeLessThanOrEqual(BOUNDS.width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(BOUNDS.height)
  })
})

describe("isFullFrame", () => {
  it("is true only for the whole frame", () => {
    expect(isFullFrame({ x: 0, y: 0, width: 800, height: 600 }, BOUNDS)).toBe(true)
    expect(isFullFrame({ x: 0, y: 0, width: 800, height: 599 }, BOUNDS)).toBe(false)
    expect(isFullFrame({ x: 1, y: 0, width: 800, height: 600 }, BOUNDS)).toBe(false)
  })
})

describe("resolveResize", () => {
  const source = { width: 800, height: 600 }

  it("takes both fields verbatim when the lock is off", () => {
    expect(
      resolveResize(source, { width: 100, height: 900 }, { lockAspect: false, edited: "width" })
    ).toEqual({ width: 100, height: 900 })
  })

  it("derives the height from the width when the lock is on", () => {
    expect(
      resolveResize(source, { width: 400, height: 999 }, { lockAspect: true, edited: "width" })
    ).toEqual({ width: 400, height: 300 })
  })

  it("derives the width from the height when the height was the edited field", () => {
    expect(
      resolveResize(source, { width: 999, height: 300 }, { lockAspect: true, edited: "height" })
    ).toEqual({ width: 400, height: 300 })
  })

  it("never resolves to a zero dimension", () => {
    expect(
      resolveResize(source, { width: 0, height: 0 }, { lockAspect: true, edited: "width" })
    ).toEqual({ width: 1, height: 1 })
  })
})

describe("displayPointToSource", () => {
  it("scales a pointer position on a shrunken preview back to source pixels", () => {
    expect(
      displayPointToSource(
        { x: 20, y: 10 },
        { width: 400, height: 300 },
        { width: 800, height: 600 }
      )
    ).toEqual({ x: 40, y: 20 })
  })

  it("is the identity when the preview is shown at source size", () => {
    const point = displayPointToSource(
      { x: 7, y: 9 },
      { width: 800, height: 600 },
      { width: 800, height: 600 }
    )
    expect(point.x).toBeCloseTo(7, 6)
    expect(point.y).toBeCloseTo(9, 6)
  })

  it("survives a zero-sized preview without dividing by zero", () => {
    const point = displayPointToSource(
      { x: 5, y: 5 },
      { width: 0, height: 0 },
      { width: 800, height: 600 }
    )
    expect(Number.isFinite(point.x)).toBe(true)
    expect(Number.isFinite(point.y)).toBe(true)
  })
})

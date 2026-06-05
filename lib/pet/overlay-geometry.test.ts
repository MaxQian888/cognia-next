import {
  MAX_RELEASE_SPEED,
  MIN_THROW_SPEED,
  OVERLAY_CHROME_H,
  OVERLAY_CHROME_W,
  clampWalkTargetX,
  overlayWindowSize,
  releaseVelocityFromSamples,
  resolveGroundTop,
  walkBoundsX,
  type WorkAreaRect,
} from "./overlay-geometry"

describe("overlayWindowSize", () => {
  it("adds the chrome margins around the pet box", () => {
    expect(overlayWindowSize(128)).toEqual({
      width: 128 + OVERLAY_CHROME_W,
      height: 128 + OVERLAY_CHROME_H,
    })
  })

  it("scales with the pet size", () => {
    const small = overlayWindowSize(96)
    const large = overlayWindowSize(256)
    expect(large.width - small.width).toBe(160)
    expect(large.height - small.height).toBe(160)
  })
})

const AREA: WorkAreaRect = { x: 100, y: 50, width: 1000, height: 800 }

describe("resolveGroundTop", () => {
  it("rests the window bottom on the work-area bottom", () => {
    expect(resolveGroundTop(AREA, 288)).toBe(50 + 800 - 288)
  })

  it("honors a secondary monitor's work-area origin offset", () => {
    expect(resolveGroundTop({ x: -1920, y: 200, width: 1920, height: 1040 }, 288)).toBe(
      200 + 1040 - 288
    )
  })
})

describe("walkBoundsX / clampWalkTargetX", () => {
  it("keeps the window fully on-monitor", () => {
    expect(walkBoundsX(AREA, 288)).toEqual({ minX: 100, maxX: 100 + 1000 - 288 })
    expect(clampWalkTargetX(-500, AREA, 288)).toBe(100)
    expect(clampWalkTargetX(5000, AREA, 288)).toBe(812)
    expect(clampWalkTargetX(400, AREA, 288)).toBe(400)
  })

  it("degenerates to minX when the window is wider than the area", () => {
    expect(walkBoundsX(AREA, 2000)).toEqual({ minX: 100, maxX: 100 })
  })
})

describe("releaseVelocityFromSamples", () => {
  it("returns zero for fewer than two samples", () => {
    expect(releaseVelocityFromSamples([])).toEqual({ vx: 0, vy: 0 })
    expect(releaseVelocityFromSamples([{ x: 0, y: 0, tMs: 0 }])).toEqual({ vx: 0, vy: 0 })
  })

  it("computes px/s over the recent window", () => {
    const v = releaseVelocityFromSamples([
      { x: 0, y: 0, tMs: 0 },
      { x: 50, y: -20, tMs: 100 },
    ])
    expect(v.vx).toBeCloseTo(500)
    expect(v.vy).toBeCloseTo(-200)
  })

  it("ignores samples older than the velocity window", () => {
    const v = releaseVelocityFromSamples([
      { x: 9999, y: 9999, tMs: 0 }, // stale — outside the 140ms window
      { x: 0, y: 0, tMs: 1000 },
      { x: 30, y: 0, tMs: 1100 },
    ])
    expect(v.vx).toBeCloseTo(300)
    expect(v.vy).toBeCloseTo(0)
  })

  it("returns zero when only one sample is inside the window", () => {
    const v = releaseVelocityFromSamples([
      { x: 0, y: 0, tMs: 0 },
      { x: 10, y: 10, tMs: 500 },
    ])
    expect(v).toEqual({ vx: 0, vy: 0 })
  })

  it("returns zero on a degenerate time span", () => {
    const v = releaseVelocityFromSamples([
      { x: 0, y: 0, tMs: 100 },
      { x: 50, y: 50, tMs: 100 },
    ])
    expect(v).toEqual({ vx: 0, vy: 0 })
  })

  it("keeps the throw threshold below the speed ceiling", () => {
    expect(MIN_THROW_SPEED).toBeGreaterThan(0)
    expect(MIN_THROW_SPEED).toBeLessThan(MAX_RELEASE_SPEED)
  })

  it("caps the speed while preserving direction", () => {
    const v = releaseVelocityFromSamples([
      { x: 0, y: 0, tMs: 0 },
      { x: 1000, y: 0, tMs: 50 }, // 20000 px/s raw
    ])
    expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(MAX_RELEASE_SPEED)
    expect(v.vx).toBeGreaterThan(0)
    expect(v.vy).toBeCloseTo(0)
  })
})

import {
  MAX_RELEASE_SPEED,
  MIN_THROW_SPEED,
  OVERLAY_CHROME_H,
  OVERLAY_CHROME_W,
  clampWalkTargetX,
  isOnPlatform,
  nearestSupportBelow,
  overlayWindowSize,
  petBoxScreenRect,
  platformBoundsX,
  reachablePlatformAbove,
  releaseVelocityFromSamples,
  resolveCssToDesktopScale,
  resolveGroundTop,
  resolvePlatformTop,
  samePlatform,
  walkBoundsX,
  type Platform,
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

describe("petBoxScreenRect", () => {
  it("locates the bottom-centered pet box inside the window at 1x", () => {
    const rect = petBoxScreenRect({ x: 1000, y: 600 }, 128, 1)
    expect(rect).toEqual({
      x: 1000 + OVERLAY_CHROME_W / 2,
      y: 600 + OVERLAY_CHROME_H,
      width: 128,
      height: 128,
    })
  })

  it("scales the logical offsets and size to physical pixels", () => {
    const rect = petBoxScreenRect({ x: 2000, y: 1200 }, 128, 2)
    expect(rect).toEqual({
      x: 2000 + OVERLAY_CHROME_W,
      y: 1200 + OVERLAY_CHROME_H * 2,
      width: 256,
      height: 256,
    })
    // The box's bottom edge is the window's bottom edge.
    const win = overlayWindowSize(128)
    expect(rect.y + rect.height).toBe(1200 + win.height * 2)
  })
})

describe("resolveCssToDesktopScale", () => {
  it("prefers the work area's reported factor", () => {
    expect(resolveCssToDesktopScale(1.5, 2, false)).toBe(1.5)
    // macOS reports 1 (points) even on a Retina display.
    expect(resolveCssToDesktopScale(1, 2, true)).toBe(1)
  })

  it("is 1 on macOS when the work area is unknown: a CSS px is a point there", () => {
    expect(resolveCssToDesktopScale(null, 2, true)).toBe(1)
    expect(resolveCssToDesktopScale(undefined, 1, true)).toBe(1)
  })

  it("falls back to devicePixelRatio elsewhere when the monitor is unknown", () => {
    expect(resolveCssToDesktopScale(null, 2, false)).toBe(2)
    expect(resolveCssToDesktopScale(undefined, 1.25, false)).toBe(1.25)
  })

  it("rejects non-positive or non-finite values and ends at 1", () => {
    expect(resolveCssToDesktopScale(0, Number.NaN, false)).toBe(1)
    expect(resolveCssToDesktopScale(-2, 0, false)).toBe(1)
    expect(resolveCssToDesktopScale(Number.POSITIVE_INFINITY, undefined, false)).toBe(1)
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

describe("platform helpers", () => {
  const win = 80 // window height/width for these cases
  const platform: Platform = { x: 200, y: 300, width: 240 }

  it("resolvePlatformTop rests the window bottom on the platform top", () => {
    expect(resolvePlatformTop(platform, win)).toBe(300 - win)
  })

  it("platformBoundsX clamps the window inside the platform span", () => {
    expect(platformBoundsX(platform, win)).toEqual({ minX: 200, maxX: 200 + 240 - 80 })
  })

  it("platformBoundsX pins a too-wide window to the platform left", () => {
    expect(platformBoundsX(platform, 999)).toEqual({ minX: 200, maxX: 200 })
  })

  it("isOnPlatform tests the window center against the span", () => {
    expect(isOnPlatform(220, win, platform)).toBe(true) // center 260 in [200,440]
    expect(isOnPlatform(380, win, platform)).toBe(true) // center 420 in span
    expect(isOnPlatform(420, win, platform)).toBe(false) // center 460 past the edge
  })

  it("samePlatform tolerates small jitter but flags real moves", () => {
    expect(samePlatform(platform, { x: 202, y: 301, width: 241 })).toBe(true)
    expect(samePlatform(platform, { x: 260, y: 300, width: 240 })).toBe(false)
    expect(samePlatform(platform, null)).toBe(false)
    expect(samePlatform(null, null)).toBe(true)
  })

  it("nearestSupportBelow falls to the floor when no platform is below", () => {
    const floorTop = 1000
    const r = nearestSupportBelow(950, 220, win, win, [], floorTop)
    expect(r).toEqual({ top: floorTop, platform: null })
  })

  it("nearestSupportBelow lands on the highest platform below the pet", () => {
    const floorTop = 1000
    const low: Platform = { x: 0, y: 800, width: 2000 } // top = 720
    const high: Platform = { x: 100, y: 400, width: 600 } // top = 320
    const r = nearestSupportBelow(100, 220, win, win, [high, low], floorTop)
    expect(r.platform).toBe(high) // 320 is the first surface below windowY 100
    expect(r.top).toBe(320)
  })

  it("nearestSupportBelow ignores platforms whose span misses the center", () => {
    const floorTop = 1000
    const offside: Platform = { x: 0, y: 400, width: 50 } // center 260 not in [0,50]
    const r = nearestSupportBelow(100, 220, win, win, [offside], floorTop)
    expect(r.platform).toBeNull()
  })

  it("reachablePlatformAbove finds a platform within hop range over the center", () => {
    const currentTop = 720 // resting on the floor-ish
    const reachable: Platform = { x: 100, y: 700, width: 400 } // top = 620, rise 100
    const tooHigh: Platform = { x: 100, y: 300, width: 400 } // top = 220, rise 500
    const got = reachablePlatformAbove(currentTop, 220, win, win, [tooHigh, reachable], 160)
    expect(got).toBe(reachable)
  })

  it("reachablePlatformAbove returns null when nothing is in range", () => {
    expect(reachablePlatformAbove(720, 220, win, win, [], 160)).toBeNull()
  })
})

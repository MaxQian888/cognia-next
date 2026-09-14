import {
  DEFAULT_VIDEO_SETTINGS,
  VIDEO_FRAME_COUNT_BOUNDS,
  VIDEO_MIN_RANGE_SEC,
  isVideoPreprocessSettings,
  isVideoTrimmed,
  normalizeVideoSettings,
  resolveVideoRange,
  sameVideoSettings,
  withVideoDelivery,
  type VideoPreprocessSettings,
} from "./settings"

const base: VideoPreprocessSettings = { ...DEFAULT_VIDEO_SETTINGS }

describe("DEFAULT_VIDEO_SETTINGS", () => {
  it("is the 9-frame uniform storyboard over the whole clip (decision D5)", () => {
    expect(DEFAULT_VIDEO_SETTINGS).toEqual({
      delivery: "storyboard",
      strategy: "uniform",
      frameCount: 9,
      range: null,
    })
    expect(Object.isFrozen(DEFAULT_VIDEO_SETTINGS)).toBe(true)
  })
})

describe("normalizeVideoSettings", () => {
  it("clamps the frame count into the delivery's bounds", () => {
    expect(normalizeVideoSettings({ ...base, frameCount: 99 }, 30).frameCount).toBe(
      VIDEO_FRAME_COUNT_BOUNDS.storyboard.max
    )
    expect(
      normalizeVideoSettings({ ...base, delivery: "frames", frameCount: 0 }, 30).frameCount
    ).toBe(VIDEO_FRAME_COUNT_BOUNDS.frames.min)
    expect(normalizeVideoSettings({ ...base, frameCount: Number.NaN }, 30).frameCount).toBe(9)
  })

  it("keeps a range inside the clip and orders its ends", () => {
    // Both ends out of the clip, reversed: clamped to 40 and 0, then ordered,
    // which is the whole clip.
    const out = normalizeVideoSettings({ ...base, range: { startSec: 50, endSec: -3 } }, 40)
    expect(out.range).toBeNull()
    const trimmed = normalizeVideoSettings({ ...base, range: { startSec: 30, endSec: 12 } }, 40)
    expect(trimmed.range).toEqual({ startSec: 12, endSec: 30 })
  })

  it("widens a range shorter than the minimum", () => {
    const out = normalizeVideoSettings({ ...base, range: { startSec: 10, endSec: 10 } }, 40)
    expect(out.range).toEqual({ startSec: 10, endSec: 10 + VIDEO_MIN_RANGE_SEC })
    const atEnd = normalizeVideoSettings({ ...base, range: { startSec: 40, endSec: 40 } }, 40)
    expect(atEnd.range).toEqual({ startSec: 40 - VIDEO_MIN_RANGE_SEC, endSec: 40 })
  })

  it("collapses a range covering the whole clip to null", () => {
    expect(
      normalizeVideoSettings({ ...base, range: { startSec: 0.01, endSec: 39.99 } }, 40).range
    ).toBeNull()
  })

  it("drops the range when the duration is unknown", () => {
    expect(
      normalizeVideoSettings({ ...base, range: { startSec: 1, endSec: 2 } }, Number.NaN).range
    ).toBeNull()
  })

  it("never lets a trim on a clip shorter than the minimum exceed the clip", () => {
    const out = normalizeVideoSettings({ ...base, range: { startSec: 0.1, endSec: 0.1 } }, 0.3)
    // Minimum is capped at the clip length, which makes it the whole clip.
    expect(out.range).toBeNull()
  })
})

describe("withVideoDelivery", () => {
  it("keeps a frame count that still fits and resets one that does not", () => {
    const nine = { ...base, frameCount: 9 }
    expect(withVideoDelivery(nine, "frames").frameCount).toBe(9)
    const sixteen = { ...base, frameCount: 16 }
    expect(withVideoDelivery(sixteen, "frames").frameCount).toBe(
      VIDEO_FRAME_COUNT_BOUNDS.frames.default
    )
    const two = { ...base, delivery: "frames" as const, frameCount: 2 }
    expect(withVideoDelivery(two, "storyboard").frameCount).toBe(9)
  })

  it("keeps the count untouched through native, so switching back restores it", () => {
    const frames = { ...base, delivery: "frames" as const, frameCount: 3 }
    const native = withVideoDelivery(frames, "native")
    expect(native).toMatchObject({ delivery: "native", frameCount: 3 })
    expect(withVideoDelivery(native, "frames").frameCount).toBe(3)
  })

  it("returns the same object when nothing changes", () => {
    expect(withVideoDelivery(base, "storyboard")).toBe(base)
  })
})

describe("range helpers", () => {
  it("resolves a null range to the whole clip", () => {
    expect(resolveVideoRange(base, 12)).toEqual({ startSec: 0, endSec: 12 })
    expect(resolveVideoRange({ ...base, range: { startSec: 2, endSec: 5 } }, 12)).toEqual({
      startSec: 2,
      endSec: 5,
    })
    expect(isVideoTrimmed(base)).toBe(false)
    expect(isVideoTrimmed({ ...base, range: { startSec: 2, endSec: 5 } })).toBe(true)
  })
})

describe("sameVideoSettings", () => {
  it("compares ranges by value", () => {
    const a = { ...base, range: { startSec: 1, endSec: 2 } }
    expect(sameVideoSettings(a, { ...base, range: { startSec: 1, endSec: 2 } })).toBe(true)
    expect(sameVideoSettings(a, { ...base, range: { startSec: 1, endSec: 3 } })).toBe(false)
    expect(sameVideoSettings(a, base)).toBe(false)
    expect(sameVideoSettings(base, { ...base })).toBe(true)
  })
})

describe("isVideoPreprocessSettings", () => {
  it("accepts the shapes this build writes", () => {
    expect(isVideoPreprocessSettings(base)).toBe(true)
    expect(isVideoPreprocessSettings({ ...base, range: { startSec: 1, endSec: 4 } })).toBe(true)
  })

  it("rejects anything a different build could have left behind", () => {
    expect(isVideoPreprocessSettings(null)).toBe(false)
    expect(isVideoPreprocessSettings({ ...base, delivery: "gif" })).toBe(false)
    expect(isVideoPreprocessSettings({ ...base, strategy: "keyframes" })).toBe(false)
    expect(isVideoPreprocessSettings({ ...base, frameCount: "9" })).toBe(false)
    expect(isVideoPreprocessSettings({ ...base, range: { startSec: 1 } })).toBe(false)
    expect(isVideoPreprocessSettings({ ...base, range: undefined })).toBe(false)
  })
})

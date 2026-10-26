import {
  clampLockBlur,
  clampLockDim,
  DEFAULT_LOCK_SCREEN,
  greetingKeyForHour,
  isLockScreenBackdrop,
  MAX_GREETING_LENGTH,
  MAX_LOCK_BLUR_PX,
  normalizeGreeting,
} from "./lock-screen"

describe("defaults", () => {
  it("ships the historical plain look, so nobody's lock screen changes unasked", () => {
    expect(DEFAULT_LOCK_SCREEN.backdrop).toBe("theme")
    expect(DEFAULT_LOCK_SCREEN.clock).toBe("none")
    expect(DEFAULT_LOCK_SCREEN.greeting).toBe("none")
    expect(DEFAULT_LOCK_SCREEN.motion).toBe("none")
  })

  it("defaults the dim high enough that a bright photograph stays readable", () => {
    expect(DEFAULT_LOCK_SCREEN.dim).toBeGreaterThanOrEqual(0.4)
  })
})

describe("isLockScreenBackdrop", () => {
  it("accepts the known backdrops", () => {
    expect(isLockScreenBackdrop("theme")).toBe(true)
    expect(isLockScreenBackdrop("wallpaper")).toBe(true)
    expect(isLockScreenBackdrop("pinned")).toBe(true)
    expect(isLockScreenBackdrop("solid")).toBe(true)
  })

  it("rejects anything else", () => {
    expect(isLockScreenBackdrop("hologram")).toBe(false)
    expect(isLockScreenBackdrop(undefined)).toBe(false)
    expect(isLockScreenBackdrop(null)).toBe(false)
  })
})

describe("clampLockBlur", () => {
  it("clamps into the supported range", () => {
    expect(clampLockBlur(-5)).toBe(0)
    expect(clampLockBlur(999)).toBe(MAX_LOCK_BLUR_PX)
    expect(clampLockBlur(12)).toBe(12)
  })

  it("rounds and falls back on nonsense", () => {
    expect(clampLockBlur(12.6)).toBe(13)
    expect(clampLockBlur(Number.NaN)).toBe(DEFAULT_LOCK_SCREEN.blurPx)
  })
})

describe("clampLockDim", () => {
  it("clamps into 0..1", () => {
    expect(clampLockDim(-1)).toBe(0)
    expect(clampLockDim(5)).toBe(1)
    expect(clampLockDim(0.35)).toBe(0.35)
  })

  it("falls back on nonsense", () => {
    expect(clampLockDim(Number.NaN)).toBe(DEFAULT_LOCK_SCREEN.dim)
  })
})

describe("normalizeGreeting", () => {
  it("trims and caps", () => {
    expect(normalizeGreeting("  hello  ")).toBe("hello")
    expect(normalizeGreeting("x".repeat(200))).toHaveLength(MAX_GREETING_LENGTH)
  })
})

describe("greetingKeyForHour", () => {
  it("maps each part of the day", () => {
    expect(greetingKeyForHour(6)).toBe("morning")
    expect(greetingKeyForHour(13)).toBe("afternoon")
    expect(greetingKeyForHour(19)).toBe("evening")
    expect(greetingKeyForHour(23)).toBe("night")
    expect(greetingKeyForHour(2)).toBe("night")
  })

  it("puts every hour of the day somewhere", () => {
    // Shared by the lock screen and the settings preview, so a gap would let
    // the two disagree about what "evening" means.
    for (let hour = 0; hour < 24; hour += 1) {
      expect(["morning", "afternoon", "evening", "night"]).toContain(greetingKeyForHour(hour))
    }
  })

  it("puts the boundaries on the later side", () => {
    expect(greetingKeyForHour(5)).toBe("morning")
    expect(greetingKeyForHour(12)).toBe("afternoon")
    expect(greetingKeyForHour(18)).toBe("evening")
    expect(greetingKeyForHour(22)).toBe("night")
  })
})

import type { PetSoundSettings } from "@/types/pet"
import {
  SFX_CUES,
  clampVolume,
  effectiveGain,
  isWithinQuietHours,
  resolveSfxCue,
  shouldPlaySfx,
  type SfxGateCtx,
} from "./sfx-gate"

const on: PetSoundSettings = { enabled: true, volume: 0.5, quietHours: null }

function ctx(overrides: Partial<SfxGateCtx> = {}): SfxGateCtx {
  return { reducedMotion: false, nowHour: 12, isUserGesture: true, event: "touch", ...overrides }
}

describe("resolveSfxCue", () => {
  it("returns a distinct cue per event", () => {
    expect(resolveSfxCue("touch")).toBe(SFX_CUES.touch)
    expect(resolveSfxCue("levelUp").freq).not.toBe(resolveSfxCue("touch").freq)
  })
})

describe("clampVolume", () => {
  it("clamps and defaults", () => {
    expect(clampVolume(0.3)).toBe(0.3)
    expect(clampVolume(2)).toBe(1)
    expect(clampVolume(-1)).toBe(0)
    expect(clampVolume(undefined)).toBe(0.5)
    expect(clampVolume(Number.NaN)).toBe(0.5)
  })
})

describe("isWithinQuietHours", () => {
  it("is false with no window or a degenerate window", () => {
    expect(isWithinQuietHours(3, null)).toBe(false)
    expect(isWithinQuietHours(3, { start: 5, end: 5 })).toBe(false)
  })

  it("handles a same-day window", () => {
    expect(isWithinQuietHours(10, { start: 9, end: 17 })).toBe(true)
    expect(isWithinQuietHours(18, { start: 9, end: 17 })).toBe(false)
  })

  it("handles a window that wraps past midnight", () => {
    expect(isWithinQuietHours(23, { start: 22, end: 7 })).toBe(true)
    expect(isWithinQuietHours(3, { start: 22, end: 7 })).toBe(true)
    expect(isWithinQuietHours(12, { start: 22, end: 7 })).toBe(false)
  })
})

describe("shouldPlaySfx", () => {
  it("is false when sound is disabled or absent", () => {
    expect(shouldPlaySfx(undefined, ctx())).toBe(false)
    expect(shouldPlaySfx({ enabled: false }, ctx())).toBe(false)
  })

  it("is false under reduced motion", () => {
    expect(shouldPlaySfx(on, ctx({ reducedMotion: true }))).toBe(false)
  })

  it("is false inside quiet hours", () => {
    const quiet: PetSoundSettings = { enabled: true, quietHours: { start: 22, end: 7 } }
    expect(shouldPlaySfx(quiet, ctx({ nowHour: 23 }))).toBe(false)
  })

  it("blocks a touch cue without a user gesture", () => {
    expect(shouldPlaySfx(on, ctx({ event: "touch", isUserGesture: false }))).toBe(false)
  })

  it("allows a reaction cue post-interaction without a gesture", () => {
    expect(shouldPlaySfx(on, ctx({ event: "reaction", isUserGesture: false }))).toBe(true)
  })

  it("allows a gestured touch cue", () => {
    expect(shouldPlaySfx(on, ctx())).toBe(true)
  })
})

describe("effectiveGain", () => {
  it("multiplies clamped volume by the cue gain", () => {
    expect(effectiveGain({ enabled: true, volume: 0.5 }, SFX_CUES.touch)).toBeCloseTo(0.25)
    expect(effectiveGain({ enabled: true, volume: 2 }, SFX_CUES.levelUp)).toBeCloseTo(0.5)
  })
})

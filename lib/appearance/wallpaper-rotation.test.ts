import {
  isAdvanceDue,
  isRotatable,
  localDayKey,
  msUntilNextAdvance,
  pickNextWallpaperId,
  resolveRotationPool,
} from "./wallpaper-rotation"
import {
  DEFAULT_WALLPAPER_ROTATION,
  type WallpaperRotationSettings,
} from "@/types/appearance/wallpaper-rotation"
import type { Wallpaper } from "@/types/appearance"

function image(id: string): Wallpaper {
  return {
    id,
    name: id,
    kind: "image",
    source: {
      kind: "image",
      storage: "indexeddb",
      blobKey: id,
      mime: "image/jpeg",
      width: 1920,
      height: 1080,
    },
    builtin: false,
    createdAt: 0,
  }
}

function gradient(id: string): Wallpaper {
  return {
    id,
    name: id,
    kind: "gradient",
    source: { kind: "gradient", css: "linear-gradient(#000, #fff)" },
    builtin: true,
    createdAt: 0,
  }
}

function color(id: string): Wallpaper {
  return {
    id,
    name: id,
    kind: "color",
    source: { kind: "color", value: "#1e293b" },
    builtin: true,
    createdAt: 0,
  }
}

function rotation(patch: Partial<WallpaperRotationSettings> = {}): WallpaperRotationSettings {
  return { ...DEFAULT_WALLPAPER_ROTATION, enabled: true, ...patch }
}

describe("isRotatable", () => {
  it("accepts images and gradients", () => {
    expect(isRotatable(image("a"))).toBe(true)
    expect(isRotatable(gradient("b"))).toBe(true)
  })

  it("rejects solid colours so a photo carousel never flips to a flat swatch", () => {
    expect(isRotatable(color("c"))).toBe(false)
  })
})

describe("resolveRotationPool", () => {
  const gallery = [image("a"), color("flat"), gradient("b"), image("c")]

  it("falls back to every rotatable wallpaper in gallery order", () => {
    expect(resolveRotationPool([], gallery)).toEqual(["a", "b", "c"])
  })

  it("honours an explicit playlist's own order", () => {
    expect(resolveRotationPool(["c", "a"], gallery)).toEqual(["c", "a"])
  })

  it("drops playlist ids whose wallpaper was deleted", () => {
    expect(resolveRotationPool(["c", "gone", "a"], gallery)).toEqual(["c", "a"])
  })

  it("keeps an explicitly listed solid colour", () => {
    // The exclusion is a DEFAULT, not a prohibition: naming it is consent.
    expect(resolveRotationPool(["flat", "a"], gallery)).toEqual(["flat", "a"])
  })

  it("de-duplicates a repeated id", () => {
    expect(resolveRotationPool(["a", "a", "c"], gallery)).toEqual(["a", "c"])
  })

  it("returns empty for a gallery with nothing rotatable", () => {
    expect(resolveRotationPool([], [color("only")])).toEqual([])
  })
})

describe("pickNextWallpaperId", () => {
  it("walks a sequential pool and wraps at the end", () => {
    const pool = ["a", "b", "c"]
    expect(pickNextWallpaperId({ pool, currentId: "a", order: "sequential" })).toBe("b")
    expect(pickNextWallpaperId({ pool, currentId: "c", order: "sequential" })).toBe("a")
  })

  it("starts at the top when nothing is active", () => {
    expect(pickNextWallpaperId({ pool: ["a", "b"], currentId: null, order: "sequential" })).toBe(
      "a"
    )
  })

  it("restarts at the top when the active wallpaper is outside the pool", () => {
    // Regression guard: indexOf returns -1, and -1 + 1 === 0 would have looked
    // correct by accident while meaning something entirely different.
    expect(pickNextWallpaperId({ pool: ["a", "b"], currentId: "zzz", order: "sequential" })).toBe(
      "a"
    )
  })

  it("returns null when there is nowhere to advance", () => {
    expect(pickNextWallpaperId({ pool: [], currentId: null, order: "sequential" })).toBeNull()
    expect(pickNextWallpaperId({ pool: ["a"], currentId: "a", order: "shuffle" })).toBeNull()
  })

  it("returns the sole wallpaper when it is not already active", () => {
    expect(pickNextWallpaperId({ pool: ["a"], currentId: null, order: "sequential" })).toBe("a")
  })

  it("never re-picks the current wallpaper under shuffle", () => {
    const pool = ["a", "b"]
    // random() === 0 would select index 0, which is "a" in the raw pool.
    expect(pickNextWallpaperId({ pool, currentId: "a", order: "shuffle", random: () => 0 })).toBe(
      "b"
    )
  })

  it("clamps an out-of-range random rather than indexing past the end", () => {
    const pool = ["a", "b", "c"]
    expect(pickNextWallpaperId({ pool, currentId: null, order: "shuffle", random: () => 1 })).toBe(
      "c"
    )
    expect(
      pickNextWallpaperId({ pool, currentId: null, order: "shuffle", random: () => NaN })
    ).toBe("a")
  })
})

describe("localDayKey", () => {
  it("keys by local calendar date", () => {
    const at = new Date(2026, 8, 3, 23, 30).getTime()
    expect(localDayKey(at)).toBe("2026-09-03")
  })

  it("zero-pads month and day", () => {
    expect(localDayKey(new Date(2026, 0, 5, 12).getTime())).toBe("2026-01-05")
  })
})

describe("isAdvanceDue", () => {
  const now = new Date(2026, 8, 3, 9, 0).getTime()

  it("is never due while disabled", () => {
    expect(isAdvanceDue({ rotation: rotation({ enabled: false }), now })).toBe(false)
  })

  it("does not fire on the very first evaluation of a timed trigger", () => {
    // Enabling a carousel must not yank away the wallpaper just chosen.
    expect(isAdvanceDue({ rotation: rotation({ lastAdvancedAt: undefined }), now })).toBe(false)
  })

  it("fires once elapsed time passes the interval", () => {
    const r = rotation({ intervalMs: 60_000, lastAdvancedAt: now - 59_000 })
    expect(isAdvanceDue({ rotation: r, now })).toBe(false)
    expect(isAdvanceDue({ rotation: { ...r, lastAdvancedAt: now - 60_000 }, now })).toBe(true)
  })

  it("treats a future lastAdvancedAt as due instead of wedging", () => {
    // A clock that moved backwards, or a settings row restored from a backup
    // taken on a machine ahead of this one.
    const r = rotation({ intervalMs: 60_000, lastAdvancedAt: now + 86_400_000 })
    expect(isAdvanceDue({ rotation: r, now })).toBe(true)
  })

  it("clamps an absurdly short interval rather than firing every tick", () => {
    const r = rotation({ intervalMs: 10, lastAdvancedAt: now - 1_000 })
    expect(isAdvanceDue({ rotation: r, now })).toBe(false)
  })

  it("fires daily on a calendar-day change, not on a 24h elapse", () => {
    const lastNight = new Date(2026, 8, 2, 23, 0).getTime()
    const r = rotation({ trigger: "daily", lastAdvancedAt: lastNight })
    expect(isAdvanceDue({ rotation: r, now })).toBe(true)
  })

  it("does not fire daily twice within one calendar day", () => {
    const earlier = new Date(2026, 8, 3, 1, 0).getTime()
    const r = rotation({ trigger: "daily", lastAdvancedAt: earlier })
    expect(isAdvanceDue({ rotation: r, now })).toBe(false)
  })

  it("fires launch exactly once per process", () => {
    const r = rotation({ trigger: "launch" })
    expect(isAdvanceDue({ rotation: r, now, isFirstEvaluation: true })).toBe(true)
    expect(isAdvanceDue({ rotation: r, now, isFirstEvaluation: false })).toBe(false)
  })
})

describe("msUntilNextAdvance", () => {
  const now = new Date(2026, 8, 3, 9, 0).getTime()

  it("returns null while disabled", () => {
    expect(msUntilNextAdvance(rotation({ enabled: false }), now)).toBeNull()
  })

  it("returns null before the first advance has been stamped", () => {
    expect(msUntilNextAdvance(rotation({ lastAdvancedAt: undefined }), now)).toBeNull()
  })

  it("returns the remaining interval", () => {
    const r = rotation({ intervalMs: 60_000, lastAdvancedAt: now - 20_000 })
    expect(msUntilNextAdvance(r, now)).toBe(40_000)
  })

  it("returns 0 for an overdue interval rather than a negative delay", () => {
    const r = rotation({ intervalMs: 60_000, lastAdvancedAt: now - 500_000 })
    expect(msUntilNextAdvance(r, now)).toBe(0)
  })

  it("returns 0 for a future stamp", () => {
    const r = rotation({ intervalMs: 60_000, lastAdvancedAt: now + 5_000 })
    expect(msUntilNextAdvance(r, now)).toBe(0)
  })

  it("counts down to local midnight for the daily trigger", () => {
    const r = rotation({ trigger: "daily", lastAdvancedAt: now - 1_000 })
    const midnight = new Date(2026, 8, 4, 0, 0, 0, 0).getTime()
    expect(msUntilNextAdvance(r, now)).toBe(midnight - now)
  })

  it("returns null for launch, which has no schedule", () => {
    expect(msUntilNextAdvance(rotation({ trigger: "launch" }), now)).toBeNull()
  })
})

import {
  MULTI_DAY_RANGE_MS,
  RANGE_PRESETS,
  axisTimeFormat,
  bucketBoundaries,
  bucketWindow,
  isValidCustomRange,
  customRange,
  pickBucketMs,
  presetDurationMs,
  resolveControlsRange,
  resolveRange,
} from "./time-range"

describe("time-range", () => {
  const NOW = 1_700_000_000_000

  it("exposes all presets in order", () => {
    expect(RANGE_PRESETS).toEqual(["5m", "15m", "1h", "6h", "24h", "7d", "30d"])
  })

  it("resolves relative presets ending at now", () => {
    const r = resolveRange("1h", NOW)
    expect(r.until).toBe(NOW)
    expect(r.since).toBe(NOW - 60 * 60_000)
    expect(r.preset).toBe("1h")
  })

  it("uses Date.now() when now is omitted", () => {
    const before = Date.now()
    const r = resolveRange("5m")
    expect(r.until).toBeGreaterThanOrEqual(before)
    expect(r.until - r.since).toBe(presetDurationMs("5m"))
  })

  it("maps each preset to its duration", () => {
    expect(presetDurationMs("5m")).toBe(300_000)
    expect(presetDurationMs("30d")).toBe(30 * 24 * 60 * 60_000)
  })

  it("normalizes custom range bounds regardless of order", () => {
    expect(customRange(200, 100)).toEqual({ since: 100, until: 200, preset: "custom" })
    expect(customRange(100, 200)).toEqual({ since: 100, until: 200, preset: "custom" })
  })

  describe("pickBucketMs", () => {
    it("snaps a 1h window to ~1m buckets for ~60 buckets", () => {
      const r = resolveRange("1h", NOW)
      expect(pickBucketMs(r)).toBe(60_000)
    })

    it("snaps a 5m window to a small step", () => {
      const r = resolveRange("5m", NOW)
      expect(pickBucketMs(r)).toBe(5_000)
    })

    it("falls back to the largest step for huge windows", () => {
      const r = customRange(0, 365 * 24 * 60 * 60_000)
      expect(pickBucketMs(r)).toBe(86_400_000)
    })

    it("guards against zero-length ranges", () => {
      const r = customRange(NOW, NOW)
      expect(pickBucketMs(r)).toBeGreaterThan(0)
    })

    it("honors a custom target bucket count", () => {
      const r = resolveRange("1h", NOW)
      // Fewer target buckets → larger bucket size.
      expect(pickBucketMs(r, 10)).toBeGreaterThan(pickBucketMs(r, 60))
    })
  })

  describe("bucketBoundaries", () => {
    it("produces aligned, ascending boundaries", () => {
      const r = customRange(1000, 4000)
      const b = bucketBoundaries(r, 1000)
      expect(b).toEqual([1000, 2000, 3000, 4000])
    })

    it("returns at least one boundary for a zero-length range", () => {
      const r = customRange(500, 500)
      expect(bucketBoundaries(r, 1000)).toEqual([500])
    })

    it("caps pathological bucket counts at 1000", () => {
      const r = customRange(0, 10_000_000)
      expect(bucketBoundaries(r, 1).length).toBe(1000)
    })

    it("guards a non-positive bucket size", () => {
      const r = customRange(0, 3)
      expect(bucketBoundaries(r, 0)).toEqual([0, 1, 2, 3])
    })
  })

  describe("resolveControlsRange", () => {
    it("slides relative presets with now", () => {
      const r = resolveControlsRange("1h", null, null, NOW)
      expect(r).toEqual({ since: NOW - 3_600_000, until: NOW, preset: "1h" })
    })

    it("freezes a complete custom range", () => {
      const r = resolveControlsRange("custom", 100, 200, NOW)
      expect(r).toEqual({ since: 100, until: 200, preset: "custom" })
    })

    it("falls back to 1h when custom bounds are incomplete", () => {
      const r = resolveControlsRange("custom", 100, null, NOW)
      expect(r.preset).toBe("1h")
      expect(r.until).toBe(NOW)
    })
  })

  describe("isValidCustomRange", () => {
    it("accepts a finite, strictly ordered pair", () => {
      expect(isValidCustomRange(100, 200)).toBe(true)
    })

    it("rejects reversed, zero-width, missing and non-finite bounds", () => {
      expect(isValidCustomRange(200, 100)).toBe(false)
      expect(isValidCustomRange(100, 100)).toBe(false)
      expect(isValidCustomRange(null, 100)).toBe(false)
      expect(isValidCustomRange(100, null)).toBe(false)
      expect(isValidCustomRange(Number.NaN, 100)).toBe(false)
      expect(isValidCustomRange(100, Number.POSITIVE_INFINITY)).toBe(false)
    })
  })

  describe("bucketWindow", () => {
    it("spans one bucket from its start", () => {
      expect(bucketWindow(1_000, 500)).toEqual({ since: 1_000, until: 1_500 })
    })

    it("clips the trailing partial bucket to the range", () => {
      expect(bucketWindow(1_000, 500, { until: 1_200 })).toEqual({ since: 1_000, until: 1_200 })
    })

    it("never returns a zero-width window", () => {
      expect(bucketWindow(1_000, 0)).toEqual({ since: 1_000, until: 1_001 })
      expect(bucketWindow(1_000, 500, { until: 900 })).toEqual({ since: 1_000, until: 1_001 })
    })
  })

  describe("axisTimeFormat", () => {
    it("is time-of-day within a day", () => {
      expect(axisTimeFormat(MULTI_DAY_RANGE_MS)).toEqual({ hour: "2-digit", minute: "2-digit" })
    })

    it("adds the date past 24h", () => {
      expect(axisTimeFormat(MULTI_DAY_RANGE_MS + 1)).toMatchObject({
        month: "short",
        day: "numeric",
        hour: "2-digit",
      })
    })

    it("drops the time past a week", () => {
      expect(axisTimeFormat(30 * MULTI_DAY_RANGE_MS)).toEqual({ month: "short", day: "numeric" })
    })
  })
})

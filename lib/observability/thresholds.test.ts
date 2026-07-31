import {
  DEFAULT_THRESHOLDS,
  evalThreshold,
  mergeThresholds,
  thresholdColorVar,
  type ThresholdConfig,
} from "./thresholds"

describe("thresholds", () => {
  describe("evalThreshold above", () => {
    const cfg: ThresholdConfig = { warn: 10, crit: 20, direction: "above" }
    it("ok below warn", () => {
      expect(evalThreshold(5, cfg)).toBe("ok")
    })
    it("warn at/above warn but below crit", () => {
      expect(evalThreshold(10, cfg)).toBe("warn")
      expect(evalThreshold(19, cfg)).toBe("warn")
    })
    it("crit at/above crit", () => {
      expect(evalThreshold(20, cfg)).toBe("crit")
      expect(evalThreshold(100, cfg)).toBe("crit")
    })
  })

  describe("evalThreshold below", () => {
    const cfg: ThresholdConfig = { warn: 0.5, crit: 0.2, direction: "below" }
    it("ok above warn", () => {
      expect(evalThreshold(0.8, cfg)).toBe("ok")
    })
    it("warn at/below warn but above crit", () => {
      expect(evalThreshold(0.5, cfg)).toBe("warn")
      expect(evalThreshold(0.3, cfg)).toBe("warn")
    })
    it("crit at/below crit", () => {
      expect(evalThreshold(0.2, cfg)).toBe("crit")
      expect(evalThreshold(0, cfg)).toBe("crit")
    })
  })

  describe("thresholdColorVar", () => {
    it("maps each level to a theme color key", () => {
      expect(thresholdColorVar("ok")).toBe("success")
      expect(thresholdColorVar("warn")).toBe("warning")
      expect(thresholdColorVar("crit")).toBe("destructive")
    })
  })

  it("ships sane defaults with correct directions", () => {
    expect(DEFAULT_THRESHOLDS.errorRate.direction).toBe("above")
    expect(DEFAULT_THRESHOLDS.cacheHitRate.direction).toBe("below")
    expect(DEFAULT_THRESHOLDS.latencyP95.crit).toBeGreaterThan(DEFAULT_THRESHOLDS.latencyP95.warn)
  })

  describe("mergeThresholds", () => {
    it("returns the defaults object when overrides are undefined", () => {
      expect(mergeThresholds(undefined)).toBe(DEFAULT_THRESHOLDS)
    })

    it("overrides warn/crit while keeping the metric's direction", () => {
      const merged = mergeThresholds({ latencyP95: { warn: 100, crit: 200 } })
      expect(merged.latencyP95).toEqual({ warn: 100, crit: 200, direction: "above" })
      // Untouched metrics keep their defaults.
      expect(merged.cost).toEqual(DEFAULT_THRESHOLDS.cost)
    })

    it("falls back to the default bound when an override value is non-finite", () => {
      const merged = mergeThresholds({ cost: { warn: Number.NaN, crit: 99 } })
      expect(merged.cost.warn).toBe(DEFAULT_THRESHOLDS.cost.warn)
      expect(merged.cost.crit).toBe(99)
    })
  })
})

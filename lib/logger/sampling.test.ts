/**
 * @jest-environment node
 */

import { configureSampling, logSampler, samplingRate } from "./sampling"

beforeEach(() => {
  logSampler.reset()
  // Reset to the built-in defaults — configureSampling merges, so empty input
  // is a no-op for the built-in keys.
})

describe("samplingRate", () => {
  it("clamps rate into [0, 1]", () => {
    expect(samplingRate(2).rate).toBe(1)
    expect(samplingRate(-1).rate).toBe(0)
    expect(samplingRate(0.42).rate).toBeCloseTo(0.42)
  })
})

describe("logSampler.shouldLog", () => {
  it("always logs error and fatal regardless of rate", () => {
    configureSampling({ test: { rate: 0 } })
    expect(logSampler.shouldLog("test", "error")).toBe(true)
    expect(logSampler.shouldLog("test", "fatal")).toBe(true)
  })

  it("respects rate=1.0 (always log) for non-error levels", () => {
    configureSampling({ "rate-1": { rate: 1.0 } })
    for (let i = 0; i < 20; i++) {
      expect(logSampler.shouldLog("rate-1", "info")).toBe(true)
    }
  })

  it("rate=0 always drops non-error levels", () => {
    configureSampling({ "rate-0": { rate: 0 } })
    for (let i = 0; i < 20; i++) {
      expect(logSampler.shouldLog("rate-0", "info")).toBe(false)
    }
  })

  it("matches by exact module name first, then by prefix", () => {
    configureSampling({
      "module.exact": { rate: 1.0 },
      module: { rate: 0 },
    })
    expect(logSampler.shouldLog("module.exact", "info")).toBe(true)
    // Prefix match: module.other → falls back to "module" (rate 0)
    expect(logSampler.shouldLog("module.other", "info")).toBe(false)
  })

  it("falls back to default when no rule matches", () => {
    configureSampling({ default: { rate: 1.0 } })
    expect(logSampler.shouldLog("totally-unconfigured", "info")).toBe(true)
  })

  it("enforces minInterval between same module/level pairs", () => {
    configureSampling({ "throttled-mod": { rate: 1.0, minInterval: 1000 } })
    expect(logSampler.shouldLog("throttled-mod", "info")).toBe(true)
    expect(logSampler.shouldLog("throttled-mod", "info")).toBe(false)
    expect(logSampler.shouldLog("throttled-mod", "info")).toBe(false)
    // Different level uses a different bucket.
    expect(logSampler.shouldLog("throttled-mod", "warn")).toBe(true)
  })
})

describe("logSampler.checkDedupe", () => {
  it("logs the first occurrence and dedupes immediate repeats", () => {
    const r1 = logSampler.checkDedupe("dedupe-mod", "info", "same-message")
    const r2 = logSampler.checkDedupe("dedupe-mod", "info", "same-message")
    expect(r1.shouldLog).toBe(true)
    expect(r2.shouldLog).toBe(false)
  })

  it("aggregates every 10th repeat with a count", () => {
    logSampler.checkDedupe("dedupe-agg", "info", "msg")
    let aggregateResult: { shouldLog: boolean; count?: number } | null = null
    for (let i = 0; i < 9; i++) {
      const r = logSampler.checkDedupe("dedupe-agg", "info", "msg")
      if (r.shouldLog) aggregateResult = r
    }
    expect(aggregateResult).not.toBeNull()
    expect(aggregateResult!.shouldLog).toBe(true)
    expect(aggregateResult!.count).toBe(10)
  })

  it("treats different module/level/message tuples as independent buckets", () => {
    expect(logSampler.checkDedupe("a", "info", "x").shouldLog).toBe(true)
    expect(logSampler.checkDedupe("a", "warn", "x").shouldLog).toBe(true)
    expect(logSampler.checkDedupe("b", "info", "x").shouldLog).toBe(true)
    expect(logSampler.checkDedupe("a", "info", "y").shouldLog).toBe(true)
    expect(logSampler.checkDedupe("a", "info", "x").shouldLog).toBe(false)
  })
})

describe("logSampler.reset", () => {
  it("clears interval-tracking state so the next call passes again", () => {
    configureSampling({ "reset-test": { rate: 1.0, minInterval: 5_000 } })
    expect(logSampler.shouldLog("reset-test", "info")).toBe(true)
    expect(logSampler.shouldLog("reset-test", "info")).toBe(false)
    logSampler.reset()
    expect(logSampler.shouldLog("reset-test", "info")).toBe(true)
  })
})

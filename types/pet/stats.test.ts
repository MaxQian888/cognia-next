import type { PetStats } from "./bones"
import {
  STAT_KEYS,
  ZERO_STAT_PROGRESS,
  effectiveStats,
  normalizeStatProgress,
  type PetStatProgress,
} from "./stats"

const base: PetStats = { debugging: 40, patience: 50, chaos: 10, wisdom: 60, snark: 30 }

describe("STAT_KEYS / ZERO_STAT_PROGRESS", () => {
  it("covers exactly the five stat keys", () => {
    expect([...STAT_KEYS].sort()).toEqual(["chaos", "debugging", "patience", "snark", "wisdom"])
  })

  it("zero progress is all zero", () => {
    for (const k of STAT_KEYS) expect(ZERO_STAT_PROGRESS[k]).toBe(0)
  })
})

describe("effectiveStats", () => {
  it("returns the base unchanged when no progress is given", () => {
    expect(effectiveStats(base)).toEqual(base)
  })

  it("adds progress per key", () => {
    const progress: PetStatProgress = { debugging: 5, patience: 0, chaos: 3, wisdom: 0, snark: 1 }
    expect(effectiveStats(base, progress)).toEqual({
      debugging: 45,
      patience: 50,
      chaos: 13,
      wisdom: 60,
      snark: 31,
    })
  })

  it("clamps the effective value to 100", () => {
    const progress: PetStatProgress = { debugging: 90, patience: 0, chaos: 0, wisdom: 0, snark: 0 }
    expect(effectiveStats(base, progress).debugging).toBe(100)
  })

  it("clamps to 0 and ignores non-finite contributions", () => {
    const progress = {
      debugging: Number.NaN,
      patience: -999,
      chaos: 0,
      wisdom: 0,
      snark: 0,
    } as unknown as PetStatProgress
    const out = effectiveStats({ ...base, patience: 5 }, progress)
    expect(out.debugging).toBe(40) // NaN contribution dropped
    expect(out.patience).toBe(0) // 5 + (-999) clamped to 0
  })
})

describe("normalizeStatProgress", () => {
  it("fills missing keys with 0", () => {
    expect(normalizeStatProgress({ debugging: 7 })).toEqual({
      debugging: 7,
      patience: 0,
      chaos: 0,
      wisdom: 0,
      snark: 0,
    })
  })

  it("clamps negatives and non-finite to 0", () => {
    const out = normalizeStatProgress({
      debugging: -3,
      patience: Number.POSITIVE_INFINITY,
      chaos: Number.NaN,
    } as Partial<PetStatProgress>)
    expect(out.debugging).toBe(0)
    expect(out.patience).toBe(0)
    expect(out.chaos).toBe(0)
  })

  it("returns all zero for undefined", () => {
    expect(normalizeStatProgress()).toEqual(ZERO_STAT_PROGRESS)
  })
})

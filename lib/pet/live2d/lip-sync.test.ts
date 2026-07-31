/** @jest-environment jsdom */
import { mouthOpenAt, LIP_SYNC_PARAM, LIP_SYNC_REST } from "./lip-sync"

describe("lip-sync", () => {
  it("targets the conventional Cubism mouth parameter and rests closed", () => {
    expect(LIP_SYNC_PARAM).toBe("ParamMouthOpenY")
    expect(LIP_SYNC_REST).toBe(0)
  })

  it("always stays within the Cubism [0, 1] parameter range", () => {
    for (let ms = 0; ms <= 5000; ms += 7) {
      const v = mouthOpenAt(ms)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it("treats negative elapsed time as the start (clamped)", () => {
    expect(mouthOpenAt(-100)).toBeCloseTo(mouthOpenAt(0))
  })

  it("actually moves the mouth over time (not a constant)", () => {
    const samples = [0, 60, 120, 180, 240, 300].map(mouthOpenAt)
    const distinct = new Set(samples.map((v) => v.toFixed(4)))
    expect(distinct.size).toBeGreaterThan(1)
    // And the mouth opens meaningfully at some point in a short window.
    expect(Math.max(...samples)).toBeGreaterThan(0.3)
  })

  it("is deterministic for a given elapsed time", () => {
    expect(mouthOpenAt(123)).toBe(mouthOpenAt(123))
  })
})

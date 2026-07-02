import { CHAOS_LIVELY_THRESHOLD, resolveWanderTuning } from "./wander-config"

describe("resolveWanderTuning", () => {
  it.each(["calm", "normal", "lively"] as const)("maps %s to sane bounds", (freq) => {
    const t = resolveWanderTuning(freq, false)
    expect(t.restMinMs).toBeGreaterThan(0)
    expect(t.restMaxMs).toBeGreaterThan(t.restMinMs)
    expect(t.walkSpeedPxPerSec).toBeGreaterThan(0)
  })

  it("orders the buckets: calm rests longest, lively walks fastest", () => {
    const calm = resolveWanderTuning("calm", false)
    const normal = resolveWanderTuning("normal", false)
    const lively = resolveWanderTuning("lively", false)
    expect(calm.restMinMs).toBeGreaterThan(normal.restMinMs)
    expect(normal.restMinMs).toBeGreaterThan(lively.restMinMs)
    expect(lively.walkSpeedPxPerSec).toBeGreaterThan(calm.walkSpeedPxPerSec)
  })

  it("low power doubles the rest intervals but keeps the speed", () => {
    const base = resolveWanderTuning("normal", false)
    const low = resolveWanderTuning("normal", true)
    expect(low.restMinMs).toBe(base.restMinMs * 2)
    expect(low.restMaxMs).toBe(base.restMaxMs * 2)
    expect(low.walkSpeedPxPerSec).toBe(base.walkSpeedPxPerSec)
  })

  describe("chaos promotion", () => {
    it("promotes one bucket livelier at the threshold", () => {
      expect(resolveWanderTuning("calm", false, CHAOS_LIVELY_THRESHOLD)).toEqual(
        resolveWanderTuning("normal", false)
      )
      expect(resolveWanderTuning("normal", false, CHAOS_LIVELY_THRESHOLD)).toEqual(
        resolveWanderTuning("lively", false)
      )
    })

    it("lively stays lively (no bucket beyond it)", () => {
      expect(resolveWanderTuning("lively", false, 100)).toEqual(
        resolveWanderTuning("lively", false)
      )
    })

    it("does nothing below the threshold or when omitted", () => {
      expect(resolveWanderTuning("calm", false, CHAOS_LIVELY_THRESHOLD - 1)).toEqual(
        resolveWanderTuning("calm", false)
      )
      expect(resolveWanderTuning("calm", false)).toEqual(resolveWanderTuning("calm", false, 0))
    })

    it("applies the low-power doubling after the promotion", () => {
      expect(resolveWanderTuning("calm", true, 100)).toEqual(resolveWanderTuning("normal", true))
    })
  })
})

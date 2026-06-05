import { resolveWanderTuning } from "./wander-config"

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
})

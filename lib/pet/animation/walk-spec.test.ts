import { resolvePetMotion } from "./motion-spec"
import { resolveWalkMotion } from "./walk-spec"

describe("resolveWalkMotion", () => {
  it("overlays a brisk looping walk bob while keeping the face", () => {
    const base = resolvePetMotion("happy", null, false, "dot")
    const walk = resolveWalkMotion(base, false)
    expect(walk.eyes).toBe(base.eyes)
    expect(walk.mouth).toBe(base.mouth)
    expect(walk.loop).toBe(true)
    expect(walk.durationSec).toBeLessThan(base.durationSec)
    expect(walk.body.y.some((v) => v !== 0)).toBe(true)
    expect(walk.body.rotate.some((v) => v !== 0)).toBe(true)
  })

  it("returns the base spec untouched under reduced motion", () => {
    const base = resolvePetMotion("idle", null, true, "dot")
    expect(resolveWalkMotion(base, true)).toBe(base)
  })
})

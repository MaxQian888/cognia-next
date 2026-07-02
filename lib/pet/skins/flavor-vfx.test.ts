import { resolveFlavorVfx } from "./flavor-vfx"

const MOTION = { reducedMotion: false, lowPower: false }
const REDUCED = { reducedMotion: true, lowPower: false }

describe("resolveFlavorVfx", () => {
  it("returns null for normal or unset flavor", () => {
    expect(resolveFlavorVfx("normal", MOTION)).toBeNull()
    expect(resolveFlavorVfx(undefined, MOTION)).toBeNull()
  })

  it("radiant earns the warm aura at full saturation", () => {
    const vfx = resolveFlavorVfx("radiant", MOTION)
    expect(vfx).toEqual({ aura: true, auraColor: "#fde68a", saturate: 1 })
  })

  it("plain desaturates without an aura", () => {
    const vfx = resolveFlavorVfx("plain", MOTION)
    expect(vfx).toEqual({ aura: false, auraColor: "transparent", saturate: 0.88 })
  })

  it("reduced motion drops the radiant aura but keeps the static saturation", () => {
    expect(resolveFlavorVfx("radiant", REDUCED)).toEqual(
      expect.objectContaining({ aura: false, saturate: 1 })
    )
    expect(resolveFlavorVfx("plain", REDUCED)?.saturate).toBe(0.88)
  })
})

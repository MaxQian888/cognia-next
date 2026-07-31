import { resolveRarityVfx, resolveShinyVfx } from "./rarity-vfx"

describe("resolveRarityVfx", () => {
  it("keeps identity under reduced motion as a fully static descriptor", () => {
    const d = resolveRarityVfx("legendary", { reducedMotion: true, lowPower: false })
    expect(d).toMatchObject({ aura: true, orbit: false, static: true, particleCount: 5 })
    // Common still earns nothing even under reduced motion.
    expect(resolveRarityVfx("common", { reducedMotion: true, lowPower: false })).toBeNull()
  })

  it("returns null for common and uncommon", () => {
    expect(resolveRarityVfx("common", { reducedMotion: false, lowPower: false })).toBeNull()
    expect(resolveRarityVfx("uncommon", { reducedMotion: false, lowPower: false })).toBeNull()
  })

  it("gives rare a static aura with no motes", () => {
    const d = resolveRarityVfx("rare", { reducedMotion: false, lowPower: false })
    expect(d).toMatchObject({ aura: true, particleCount: 0, orbit: false })
  })

  it("gives epic orbiting motes", () => {
    const d = resolveRarityVfx("epic", { reducedMotion: false, lowPower: false })
    expect(d).toMatchObject({ aura: true, particleCount: 3, orbit: true })
  })

  it("gives legendary the most motes and a gold aura", () => {
    const d = resolveRarityVfx("legendary", { reducedMotion: false, lowPower: false })
    expect(d?.particleCount).toBe(5)
    expect(d?.auraColor).toBe("#fbbf24")
  })

  it("halves particles and disables orbit under low power", () => {
    const d = resolveRarityVfx("legendary", { reducedMotion: false, lowPower: true })
    expect(d?.particleCount).toBe(2)
    expect(d?.orbit).toBe(false)
    expect(d?.aura).toBe(true)
  })
})

describe("resolveShinyVfx", () => {
  it("returns null when not shiny", () => {
    expect(resolveShinyVfx(false, { reducedMotion: false, lowPower: false })).toBeNull()
  })

  it("returns null under reduced motion", () => {
    expect(resolveShinyVfx(true, { reducedMotion: true, lowPower: false })).toBeNull()
  })

  it("gives a rainbow shimmer when shiny", () => {
    expect(resolveShinyVfx(true, { reducedMotion: false, lowPower: false })).toEqual({
      rainbow: true,
      shimmerCount: 3,
    })
  })

  it("reduces the shimmer under low power", () => {
    expect(resolveShinyVfx(true, { reducedMotion: false, lowPower: true })?.shimmerCount).toBe(1)
  })
})

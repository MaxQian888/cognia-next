import {
  createSimState,
  EFFECT_SPECS,
  MAX_PARTICLES,
  particleProgress,
  spawnAmbient,
  spawnBurst,
  spawnForMove,
  stepParticles,
  type SpawnOptions,
} from "./particle-sim"
import { CURSOR_EFFECT_KINDS } from "@/types/appearance"

/** Deterministic RNG so spawn geometry is reproducible. */
function seeded(start = 0.5): () => number {
  let value = start
  return () => {
    value = (value * 9301 + 49297) % 233280
    return value / 233280
  }
}

function options(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return { spec: EFFECT_SPECS.trail, intensity: 1, scale: 1, rainbow: false, ...overrides }
}

describe("EFFECT_SPECS", () => {
  it("defines a spec for every effect kind except `none`", () => {
    const specced = Object.keys(EFFECT_SPECS).sort()
    const expected = CURSOR_EFFECT_KINDS.filter((k) => k !== "none").sort()
    expect(specced).toEqual([...expected])
  })

  it("gives every effect some way to produce particles or a halo", () => {
    for (const [kind, spec] of Object.entries(EFFECT_SPECS)) {
      const emits = spec.spawnPerPx > 0 || spec.spawnPerSec > 0 || spec.burst > 0 || !!spec.halo
      expect([kind, emits]).toEqual([kind, true])
    }
  })

  it("keeps every lifetime and size range ordered and positive", () => {
    for (const spec of Object.values(EFFECT_SPECS)) {
      expect(spec.life[0]).toBeGreaterThan(0)
      expect(spec.life[1]).toBeGreaterThanOrEqual(spec.life[0])
      expect(spec.size[0]).toBeGreaterThan(0)
      expect(spec.size[1]).toBeGreaterThanOrEqual(spec.size[0])
    }
  })
})

describe("spawnForMove", () => {
  it("emits nothing on the first sample — there is no segment to distribute along", () => {
    const state = createSimState(seeded())
    spawnForMove(state, options(), 10, 10, 16)
    expect(state.particles).toHaveLength(0)
    expect(state.last).toEqual({ x: 10, y: 10 })
  })

  it("emits in proportion to distance travelled, not to frames elapsed", () => {
    const short = createSimState(seeded())
    spawnForMove(short, options(), 0, 0, 16)
    spawnForMove(short, options(), 10, 0, 16)

    const long = createSimState(seeded())
    spawnForMove(long, options(), 0, 0, 16)
    spawnForMove(long, options(), 100, 0, 16)

    expect(long.particles.length).toBeGreaterThan(short.particles.length * 5)
  })

  it("distributes the burst along the segment instead of piling it at the end", () => {
    const state = createSimState(seeded())
    spawnForMove(state, options(), 0, 0, 16)
    spawnForMove(state, options(), 200, 0, 16)
    const xs = state.particles.map((p) => p.x)
    expect(Math.min(...xs)).toBeLessThan(50)
    expect(Math.max(...xs)).toBeGreaterThan(150)
  })

  it("carries the fractional remainder so a slow drag still emits eventually", () => {
    const state = createSimState(seeded())
    // trail spawns 0.28/px: a 1px step never reaches a whole particle alone.
    spawnForMove(state, options(), 0, 0, 16)
    spawnForMove(state, options(), 1, 0, 16)
    expect(state.particles).toHaveLength(0)
    expect(state.emitDebt).toBeGreaterThan(0)
    for (let i = 2; i <= 5; i++) spawnForMove(state, options(), i, 0, 16)
    expect(state.particles.length).toBeGreaterThan(0)
  })

  it("caps the catch-up so a flick across the screen stays a trail, not a wall", () => {
    const state = createSimState(seeded())
    spawnForMove(state, options(), 0, 0, 16)
    spawnForMove(state, options(), 4000, 0, 16)
    expect(state.particles.length).toBeLessThanOrEqual(24)
  })

  it("scales emission with intensity", () => {
    const low = createSimState(seeded())
    spawnForMove(low, options({ intensity: 0.1 }), 0, 0, 16)
    spawnForMove(low, options({ intensity: 0.1 }), 100, 0, 16)
    const high = createSimState(seeded())
    spawnForMove(high, options({ intensity: 1 }), 0, 0, 16)
    spawnForMove(high, options({ intensity: 1 }), 100, 0, 16)
    expect(high.particles.length).toBeGreaterThan(low.particles.length)
  })

  it("emits nothing for a movement-independent effect like ripple", () => {
    const state = createSimState(seeded())
    const opts = options({ spec: EFFECT_SPECS.ripple })
    spawnForMove(state, opts, 0, 0, 16)
    spawnForMove(state, opts, 300, 300, 16)
    expect(state.particles).toHaveLength(0)
  })

  it("smooths the velocity estimate instead of tracking each raw sample", () => {
    const state = createSimState(seeded())
    spawnForMove(state, options(), 0, 0, 16)
    spawnForMove(state, options(), 160, 0, 16)
    // A raw estimate would be 10000 px/s; the 0.4 smoothing factor keeps it well under.
    expect(state.vx).toBeGreaterThan(0)
    expect(state.vx).toBeLessThan((160 / 16) * 1000)
  })

  it("ignores a zero-length move", () => {
    const state = createSimState(seeded())
    spawnForMove(state, options(), 5, 5, 16)
    spawnForMove(state, options(), 5, 5, 16)
    expect(state.particles).toHaveLength(0)
  })
})

describe("spawnAmbient", () => {
  it("emits over time once the pointer has been seen", () => {
    const state = createSimState(seeded())
    const opts = options({ spec: EFFECT_SPECS.flame })
    spawnForMove(state, opts, 20, 20, 16)
    spawnAmbient(state, opts, 1000)
    expect(state.particles.length).toBeGreaterThan(0)
    expect(state.particles[0].x).toBe(20)
  })

  it("emits nothing before the first pointer sample", () => {
    const state = createSimState(seeded())
    spawnAmbient(state, options({ spec: EFFECT_SPECS.flame }), 1000)
    expect(state.particles).toHaveLength(0)
  })

  it("emits nothing for an effect with no ambient rate", () => {
    const state = createSimState(seeded())
    spawnForMove(state, options(), 20, 20, 16)
    spawnAmbient(state, options(), 1000)
    expect(state.particles).toHaveLength(0)
  })
})

describe("spawnBurst", () => {
  it("emits a burst at the click point and remembers it as the pointer", () => {
    const state = createSimState(seeded())
    spawnBurst(state, options({ spec: EFFECT_SPECS.sparkle }), 42, 24)
    expect(state.particles.length).toBe(EFFECT_SPECS.sparkle.burst)
    expect(state.last).toEqual({ x: 42, y: 24 })
  })

  it("still emits at least one particle at the lowest intensity", () => {
    const state = createSimState(seeded())
    spawnBurst(state, options({ spec: EFFECT_SPECS.ripple, intensity: 0.01 }), 0, 0)
    expect(state.particles.length).toBeGreaterThanOrEqual(1)
  })

  it("assigns a hue only in rainbow mode", () => {
    const flat = createSimState(seeded())
    spawnBurst(flat, options({ spec: EFFECT_SPECS.sparkle }), 0, 0)
    expect(flat.particles.every((p) => p.hue === -1)).toBe(true)

    const rainbow = createSimState(seeded())
    spawnBurst(rainbow, options({ spec: EFFECT_SPECS.sparkle, rainbow: true }), 0, 0)
    expect(rainbow.particles.every((p) => p.hue >= 0 && p.hue <= 360)).toBe(true)
  })

  it("applies the user's size multiplier", () => {
    const small = createSimState(seeded())
    spawnBurst(small, options({ spec: EFFECT_SPECS.sparkle, scale: 0.5 }), 0, 0)
    const large = createSimState(seeded())
    spawnBurst(large, options({ spec: EFFECT_SPECS.sparkle, scale: 2 }), 0, 0)
    expect(large.particles[0].size).toBeCloseTo(small.particles[0].size * 4, 5)
  })

  it("evicts the oldest particle once the hard cap is reached", () => {
    const state = createSimState(seeded())
    for (let i = 0; i < 60; i++) {
      spawnBurst(state, options({ spec: EFFECT_SPECS.stardust }), i, 0)
    }
    expect(state.particles.length).toBe(MAX_PARTICLES)
    // The survivors are the newest, so the oldest x values are gone.
    expect(Math.min(...state.particles.map((p) => p.x))).toBeGreaterThan(0)
  })
})

describe("stepParticles", () => {
  it("retires particles once they outlive their lifetime and reports the live count", () => {
    const state = createSimState(seeded())
    spawnBurst(state, options({ spec: EFFECT_SPECS.trail }), 0, 0)
    expect(state.particles.length).toBeGreaterThan(0)
    const live = stepParticles(state, EFFECT_SPECS.trail, 10_000)
    expect(live).toBe(0)
    expect(state.particles).toHaveLength(0)
  })

  it("integrates gravity, so sakura petals fall and bubbles rise", () => {
    const petal = createSimState(seeded())
    spawnBurst(petal, options({ spec: { ...EFFECT_SPECS.petals, spread: 0 } }), 0, 0)
    stepParticles(petal, EFFECT_SPECS.petals, 200)
    expect(petal.particles[0].y).toBeGreaterThan(0)

    const bubble = createSimState(seeded())
    spawnBurst(bubble, options({ spec: { ...EFFECT_SPECS.bubbles, spread: 0 } }), 0, 0)
    stepParticles(bubble, EFFECT_SPECS.bubbles, 200)
    expect(bubble.particles[0].y).toBeLessThan(0)
  })

  it("applies drag frame-rate independently", () => {
    const spec = { ...EFFECT_SPECS.trail, gravity: 0, drag: 0.5, spread: 0 }
    const make = () => {
      const state = createSimState(seeded())
      spawnBurst(state, options({ spec }), 0, 0)
      state.particles.forEach((p) => {
        p.vx = 100
        p.vy = 0
      })
      return state
    }
    const oneStep = make()
    stepParticles(oneStep, spec, 100)
    const twoSteps = make()
    stepParticles(twoSteps, spec, 50)
    stepParticles(twoSteps, spec, 50)
    expect(oneStep.particles[0].vx).toBeCloseTo(twoSteps.particles[0].vx, 6)
  })

  it("advances rotation for spinning shapes", () => {
    const state = createSimState(seeded())
    spawnBurst(state, options({ spec: EFFECT_SPECS.petals }), 0, 0)
    const before = state.particles[0].rotation
    stepParticles(state, EFFECT_SPECS.petals, 200)
    expect(state.particles[0].rotation).not.toBe(before)
  })
})

describe("particleProgress", () => {
  it("reports 0 at spawn and 1 at the end of life", () => {
    const base = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      size: 1,
      rotation: 0,
      spin: 0,
      seed: 0,
      hue: -1,
      shape: "dot" as const,
    }
    expect(particleProgress({ ...base, age: 0, life: 100 })).toBe(0)
    expect(particleProgress({ ...base, age: 50, life: 100 })).toBe(0.5)
    expect(particleProgress({ ...base, age: 500, life: 100 })).toBe(1)
  })

  it("treats a zero lifetime as finished rather than dividing by zero", () => {
    expect(
      particleProgress({
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        age: 5,
        life: 0,
        size: 1,
        rotation: 0,
        spin: 0,
        seed: 0,
        hue: -1,
        shape: "dot",
      })
    ).toBe(0)
  })
})

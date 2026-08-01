// Pointer-effect particle simulation.
//
// Pure and headless: no canvas, no DOM, no clock of its own. The layer
// component feeds it pointer samples and frame deltas; this module owns spawn
// rates, integration, and the lifetime bookkeeping. Keeping it separate is what
// makes the effects testable at all — the alternative (simulate inside the rAF
// callback) can only be checked by eyeballing pixels.
//
// Emission is distance-based, not frame-based. A frame-based rate emits the
// same number of particles whether the pointer crawled two pixels or flew
// across the screen, which reads as a dense clot when slow and a dotted line
// when fast. Distance-based emission with a carried remainder gives an even
// trail at any speed and any frame rate.

import type { CursorEffectKind } from "@/types/appearance"

/** How a particle is drawn. The renderer owns the actual geometry. */
export type ParticleShape =
  "dot" | "spark" | "star" | "petal" | "ring" | "flake" | "bubble" | "flame" | "node"

export interface Particle {
  x: number
  y: number
  /** px/s */
  vx: number
  vy: number
  /** ms since spawn */
  age: number
  /** ms total lifetime */
  life: number
  /** base radius in px */
  size: number
  /** radians */
  rotation: number
  /** radians/s */
  spin: number
  /** 0..1, stable per particle — shape variety without extra RNG calls. */
  seed: number
  /** 0..360 for the rainbow color mode; `-1` when a flat color is used. */
  hue: number
  shape: ParticleShape
}

export interface EffectSpec {
  shape: ParticleShape
  /** Particles per pixel of pointer travel, at intensity 1. */
  spawnPerPx: number
  /** Particles per second emitted regardless of movement, at intensity 1. */
  spawnPerSec: number
  /** Lifetime range in ms. */
  life: [number, number]
  /** Base radius range in px, before the user's scale multiplier. */
  size: [number, number]
  /** Downward acceleration, px/s². Negative floats upward. */
  gravity: number
  /** Fraction of velocity retained per second (1 = no drag). */
  drag: number
  /** Fraction of the pointer's velocity a new particle inherits. */
  inheritVelocity: number
  /** Random velocity magnitude added at spawn, px/s. */
  spread: number
  /** Particles emitted by a click burst, at intensity 1. */
  burst: number
  /** Rotation speed range, radians/s. */
  spin: [number, number]
  /** Draw with `lighter` compositing — right for anything that glows. */
  additive: boolean
  /** Grow the radius over the lifetime (ripples) instead of holding it. */
  expand?: number
  /** Draw a persistent halo locked to the pointer (the `glow` effect). */
  halo?: { radius: number; opacity: number }
  /** Connect live particles into one tapered stroke (the `ribbon` effect). */
  connect?: boolean
}

/**
 * Per-effect tuning. These numbers are the whole design of each effect, so they
 * live in one table rather than being scattered through the renderer.
 */
export const EFFECT_SPECS: Record<Exclude<CursorEffectKind, "none">, EffectSpec> = {
  trail: {
    shape: "dot",
    spawnPerPx: 0.28,
    spawnPerSec: 0,
    life: [420, 620],
    size: [2.5, 5],
    gravity: 0,
    drag: 0.12,
    inheritVelocity: 0.08,
    spread: 14,
    burst: 10,
    spin: [0, 0],
    additive: false,
  },
  ribbon: {
    shape: "node",
    spawnPerPx: 0.5,
    spawnPerSec: 0,
    life: [340, 380],
    size: [5, 6],
    gravity: 0,
    drag: 0.5,
    inheritVelocity: 0.05,
    spread: 0,
    burst: 0,
    spin: [0, 0],
    additive: false,
    connect: true,
  },
  glow: {
    shape: "dot",
    spawnPerPx: 0,
    spawnPerSec: 0,
    life: [1, 1],
    size: [1, 1],
    gravity: 0,
    drag: 1,
    inheritVelocity: 0,
    spread: 0,
    burst: 14,
    spin: [0, 0],
    additive: true,
    halo: { radius: 46, opacity: 0.3 },
  },
  ripple: {
    shape: "ring",
    spawnPerPx: 0,
    spawnPerSec: 0,
    life: [520, 560],
    size: [6, 8],
    gravity: 0,
    drag: 1,
    inheritVelocity: 0,
    spread: 0,
    burst: 2,
    spin: [0, 0],
    additive: false,
    expand: 46,
  },
  sparkle: {
    shape: "star",
    spawnPerPx: 0.14,
    spawnPerSec: 0,
    life: [520, 900],
    size: [3, 6.5],
    gravity: 26,
    drag: 0.5,
    inheritVelocity: 0.05,
    spread: 34,
    burst: 14,
    spin: [-3, 3],
    additive: true,
  },
  bubbles: {
    shape: "bubble",
    spawnPerPx: 0.1,
    spawnPerSec: 2,
    life: [900, 1500],
    size: [3.5, 9],
    gravity: -34,
    drag: 0.7,
    inheritVelocity: 0.05,
    spread: 22,
    burst: 12,
    spin: [-1, 1],
    additive: false,
  },
  snow: {
    shape: "flake",
    spawnPerPx: 0.1,
    spawnPerSec: 3,
    life: [1400, 2200],
    size: [2.5, 5.5],
    gravity: 26,
    drag: 0.8,
    inheritVelocity: 0.04,
    spread: 16,
    burst: 12,
    spin: [-2, 2],
    additive: false,
  },
  flame: {
    shape: "flame",
    spawnPerPx: 0.3,
    spawnPerSec: 16,
    life: [340, 620],
    size: [4, 9],
    gravity: -120,
    drag: 0.35,
    inheritVelocity: 0.12,
    spread: 26,
    burst: 18,
    spin: [-1.5, 1.5],
    additive: true,
  },
  petals: {
    shape: "petal",
    spawnPerPx: 0.075,
    spawnPerSec: 1.6,
    life: [1600, 2600],
    size: [4, 8],
    gravity: 42,
    drag: 0.75,
    inheritVelocity: 0.06,
    spread: 26,
    burst: 12,
    spin: [-2.4, 2.4],
    additive: false,
  },
  stardust: {
    shape: "spark",
    spawnPerPx: 0.22,
    spawnPerSec: 1,
    life: [600, 1100],
    size: [2, 5],
    gravity: -14,
    drag: 0.45,
    inheritVelocity: 0.1,
    spread: 40,
    burst: 20,
    spin: [-4, 4],
    additive: true,
  },
}

/**
 * Hard ceiling on live particles, independent of intensity. A user who drags
 * a maximum-intensity flame across a 4K display would otherwise accumulate
 * thousands of particles and turn a decoration into a frame-rate problem.
 */
export const MAX_PARTICLES = 420

export interface SimState {
  particles: Particle[]
  /** Fractional particles carried between frames so emission stays even. */
  emitDebt: number
  /** Last pointer sample, or `null` before the first move. */
  last: { x: number; y: number } | null
  /** Smoothed pointer velocity in px/s, used for `inheritVelocity`. */
  vx: number
  vy: number
  rng: () => number
}

export function createSimState(rng: () => number = Math.random): SimState {
  return { particles: [], emitDebt: 0, last: null, vx: 0, vy: 0, rng }
}

function between(rng: () => number, range: [number, number]): number {
  return range[0] + rng() * (range[1] - range[0])
}

/** Push a particle, evicting the oldest when the cap is reached. */
function push(state: SimState, particle: Particle): void {
  if (state.particles.length >= MAX_PARTICLES) state.particles.shift()
  state.particles.push(particle)
}

export interface SpawnOptions {
  spec: EffectSpec
  /** 0..1 user intensity. */
  intensity: number
  /** 0.5..2 user size multiplier. */
  scale: number
  /** True when the rainbow color mode is active. */
  rainbow: boolean
}

function makeParticle(
  state: SimState,
  { spec, scale, rainbow }: SpawnOptions,
  x: number,
  y: number
): Particle {
  const rng = state.rng
  const angle = rng() * Math.PI * 2
  const speed = rng() * spec.spread
  return {
    x,
    y,
    vx: state.vx * spec.inheritVelocity + Math.cos(angle) * speed,
    vy: state.vy * spec.inheritVelocity + Math.sin(angle) * speed,
    age: 0,
    life: between(rng, spec.life),
    size: between(rng, spec.size) * scale,
    rotation: rng() * Math.PI * 2,
    spin: between(rng, spec.spin),
    seed: rng(),
    hue: rainbow ? rng() * 360 : -1,
    shape: spec.shape,
  }
}

/**
 * Advance the pointer to a new sample and emit the travel-proportional
 * particles. `dtMs` is the time since the previous sample and is used only for
 * the velocity estimate.
 */
export function spawnForMove(
  state: SimState,
  options: SpawnOptions,
  x: number,
  y: number,
  dtMs: number
): void {
  const prev = state.last
  state.last = { x, y }
  if (!prev) return

  const dx = x - prev.x
  const dy = y - prev.y
  const distance = Math.hypot(dx, dy)
  if (dtMs > 0) {
    // Exponential smoothing — a raw per-sample velocity is spiky enough that
    // `inheritVelocity` would make the trail stutter.
    const instVx = (dx / dtMs) * 1000
    const instVy = (dy / dtMs) * 1000
    state.vx = state.vx * 0.6 + instVx * 0.4
    state.vy = state.vy * 0.6 + instVy * 0.4
  }
  if (distance <= 0 || options.spec.spawnPerPx <= 0) return

  state.emitDebt += distance * options.spec.spawnPerPx * clamp01(options.intensity)
  let budget = Math.floor(state.emitDebt)
  if (budget <= 0) return
  state.emitDebt -= budget
  // One frame can legitimately cover a long jump (a flick, or a re-entry after
  // the pointer left the window); cap the catch-up so it stays a trail rather
  // than a wall.
  budget = Math.min(budget, 24)
  for (let i = 0; i < budget; i++) {
    // Distribute along the segment travelled, not all at the end point.
    const t = (i + 1) / budget
    push(state, makeParticle(state, options, prev.x + dx * t, prev.y + dy * t))
  }
}

/** Emit the movement-independent drizzle (bubbles, snow, flame). */
export function spawnAmbient(state: SimState, options: SpawnOptions, dtMs: number): void {
  const rate = options.spec.spawnPerSec * clamp01(options.intensity)
  if (rate <= 0 || !state.last) return
  state.emitDebt += (rate * dtMs) / 1000
  const budget = Math.min(Math.floor(state.emitDebt), 12)
  if (budget <= 0) return
  state.emitDebt -= budget
  for (let i = 0; i < budget; i++) {
    push(state, makeParticle(state, options, state.last.x, state.last.y))
  }
}

/** Emit a click burst. Scales with intensity but always emits at least one. */
export function spawnBurst(state: SimState, options: SpawnOptions, x: number, y: number): void {
  const count = Math.max(1, Math.round(options.spec.burst * clamp01(options.intensity)))
  state.last = { x, y }
  for (let i = 0; i < count; i++) push(state, makeParticle(state, options, x, y))
}

/**
 * Integrate one frame. Returns the number of live particles so the caller can
 * park the rAF loop when the field is empty — an idle effect must not keep a
 * timer running for the life of the app.
 */
export function stepParticles(state: SimState, spec: EffectSpec, dtMs: number): number {
  const dt = dtMs / 1000
  // Per-second drag expressed as an exponential decay, so the result is frame
  // rate independent (a naive `v *= drag` per frame is not).
  const damping = spec.drag >= 1 ? 1 : Math.pow(spec.drag, dt)
  const live: Particle[] = []
  for (const p of state.particles) {
    p.age += dtMs
    if (p.age >= p.life) continue
    p.vy += spec.gravity * dt
    p.vx *= damping
    p.vy *= damping
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.rotation += p.spin * dt
    live.push(p)
  }
  state.particles = live
  return live.length
}

/** Remaining life as 0..1, where 1 is freshly spawned. */
export function particleProgress(p: Particle): number {
  return p.life <= 0 ? 0 : Math.min(Math.max(p.age / p.life, 0), 1)
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
}

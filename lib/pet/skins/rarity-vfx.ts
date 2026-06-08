// Pure VFX-selection for the SVG skin's rarity + shiny flourishes, decoupled
// from the framer-motion JSX so the policy is unit-testable. Higher rarity tiers
// gain an ambient aura (and orbiting motes for epic/legendary); shiny pets gain a
// rainbow shimmer. Both respect reduced motion (→ null) and low-power (fewer
// particles, static aura). Kept tasteful: common/uncommon get nothing.

import type { PetRarity } from "@/types/pet"

export interface RarityVfxDescriptor {
  /** Render the breathing aura ring. */
  aura: boolean
  /** Aura stroke color (literal — visual only, no i18n). */
  auraColor: string
  /** Number of orbiting motes (0 = none). */
  particleCount: number
  /** Whether motes orbit (animated) vs sit static (low-power). */
  orbit: boolean
}

export interface ShinyVfxDescriptor {
  rainbow: boolean
  shimmerCount: number
}

export interface VfxOpts {
  reducedMotion: boolean
  lowPower: boolean
}

const AURA_COLORS: Record<PetRarity, string> = {
  common: "transparent",
  uncommon: "transparent",
  rare: "#7cc4ff", // soft blue
  epic: "#c084fc", // violet
  legendary: "#fbbf24", // gold
}

const BASE_PARTICLES: Record<PetRarity, number> = {
  common: 0,
  uncommon: 0,
  rare: 0,
  epic: 3,
  legendary: 5,
}

/** Ambient rarity flourish, or null when the tier earns none / motion is off. */
export function resolveRarityVfx(rarity: PetRarity, opts: VfxOpts): RarityVfxDescriptor | null {
  if (opts.reducedMotion) return null
  if (rarity === "common" || rarity === "uncommon") return null
  const base = BASE_PARTICLES[rarity]
  const particleCount = opts.lowPower ? Math.floor(base / 2) : base
  return {
    aura: true,
    auraColor: AURA_COLORS[rarity],
    particleCount,
    orbit: !opts.lowPower && particleCount > 0,
  }
}

/** Shiny shimmer descriptor, or null when not shiny / motion is off. */
export function resolveShinyVfx(shiny: boolean, opts: VfxOpts): ShinyVfxDescriptor | null {
  if (!shiny || opts.reducedMotion) return null
  return { rainbow: true, shimmerCount: opts.lowPower ? 1 : 3 }
}

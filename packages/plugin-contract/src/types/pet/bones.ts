// Deterministic appearance ("Bones") for the pet. Bones are recomputed from a
// stable account identifier on every load and NEVER persisted — the merge order
// `{ ...soul, ...bones }` lets bones override any stored field, so the rarity you
// have is the rarity mined from your account, not one you could edit in. See
// `lib/pet/bones/generate.ts` and ADR/spec `2026-06-02-pet-system-design.md`.

/** The 18 fixed species. A closed set keeps rarity probabilities balanced. */
export type PetSpecies =
  | "duck"
  | "cat"
  | "rabbit"
  | "owl"
  | "penguin"
  | "turtle"
  | "fox"
  | "dragon"
  | "axolotl"
  | "blob"
  | "cactus"
  | "mushroom"
  | "capybara"
  | "robot"
  | "ghost"
  | "octopus"
  | "snail"
  | "chonk"

/** Rarity tiers, ordered from most to least common. */
export type PetRarity = "common" | "uncommon" | "rare" | "epic" | "legendary"

/** Eye shapes — drive both the resting look and the blink frames. */
export type PetEyes = "dot" | "sleepy" | "wide" | "wink" | "star" | "spiral"

/** Cosmetic hats. `tinyduck` is legendary-only; `none` is the common default. */
export type PetHat =
  "none" | "crown" | "tophat" | "propeller" | "halo" | "wizard" | "beanie" | "tinyduck"

/** Body silhouette — affects the skeleton proportions. */
export type PetBodyType = "round" | "tall" | "wide"

/** Resolved colour palette (oklch strings, theme-aware where possible). */
export interface PetPalette {
  primary: string
  secondary: string
  accent: string
}

/** Five flavour stats (0–100). Shown on the stat card; do not affect mechanics. */
export interface PetStats {
  debugging: number
  patience: number
  chaos: number
  wisdom: number
  snark: number
}

/** The full deterministic appearance bundle. */
export interface PetBones {
  species: PetSpecies
  rarity: PetRarity
  /** Star count 1–5, derived from rarity; precomputed for the stat card. */
  stars: number
  eyes: PetEyes
  hat: PetHat
  /** Independent 1 % roll — adds a rainbow shimmer + sparkle VFX. */
  shiny: boolean
  bodyType: PetBodyType
  palette: PetPalette
  stats: PetStats
}

/**
 * User-chosen cosmetic overrides applied over the genetic bones at render time.
 * Restyling only — restricted to the non-identity visuals so species, rarity,
 * stars, shiny, and stats (which drive the dex + achievements) stay immutable.
 */
export type PetCosmeticOverride = Partial<Pick<PetBones, "palette" | "hat" | "eyes" | "bodyType">>

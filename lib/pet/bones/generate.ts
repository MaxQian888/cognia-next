// Deterministic "Bones" generation: a stable account id → a full appearance.
// The order of rng() draws is fixed and load-bearing (changing it reshuffles
// everyone's pet), so treat this sequence as an interface. See `prng.ts`.

import type {
  PetBodyType,
  PetBones,
  PetEyes,
  PetHat,
  PetPalette,
  PetRarity,
  PetStats,
} from "@/types/pet"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"
import { pick, randInt, seededRng, shuffle } from "./prng"

/** Salt binding the pet to "this app, this era" — never change it. */
export const PET_BONES_SALT = "cognia-pet-2026"

const EYES: PetEyes[] = ["dot", "sleepy", "wide", "wink", "star", "spiral"]
const BODY_TYPES: PetBodyType[] = ["round", "tall", "wide"]
const STAT_KEYS: (keyof PetStats)[] = ["debugging", "patience", "chaos", "wisdom", "snark"]

/** Rarity cumulative weights (common→legendary): 60 / 25 / 10 / 4 / 1 %. */
const RARITY_TABLE: { rarity: PetRarity; cumulative: number; stars: number; floor: number }[] = [
  { rarity: "common", cumulative: 0.6, stars: 1, floor: 5 },
  { rarity: "uncommon", cumulative: 0.85, stars: 2, floor: 15 },
  { rarity: "rare", cumulative: 0.95, stars: 3, floor: 25 },
  { rarity: "epic", cumulative: 0.99, stars: 4, floor: 35 },
  { rarity: "legendary", cumulative: 1.0, stars: 5, floor: 50 },
]

/** Hats available at each rarity (higher tiers unlock fancier hats). */
const HATS_BY_RARITY: Record<PetRarity, PetHat[]> = {
  common: ["none", "none", "beanie"],
  uncommon: ["none", "none", "beanie", "propeller"],
  rare: ["none", "beanie", "propeller", "tophat"],
  epic: ["none", "beanie", "propeller", "tophat", "wizard", "halo"],
  legendary: ["none", "crown", "tophat", "wizard", "halo", "tinyduck"],
}

function rollRarity(roll: number): (typeof RARITY_TABLE)[number] {
  for (const entry of RARITY_TABLE) {
    if (roll < entry.cumulative) return entry
  }
  return RARITY_TABLE[RARITY_TABLE.length - 1]
}

function paletteFromHue(hue: number): PetPalette {
  return {
    primary: `oklch(0.82 0.13 ${hue})`,
    secondary: `oklch(0.93 0.06 ${hue})`,
    accent: `oklch(0.6 0.17 ${(hue + 28) % 360})`,
  }
}

function rollStats(rng: () => number, floor: number): PetStats {
  const order = shuffle(rng, STAT_KEYS)
  const values = [
    randInt(rng, Math.max(80, floor), 100), // one peak
    randInt(rng, floor, Math.min(floor + 15, 99)), // one floor-ish
    randInt(rng, floor, 99),
    randInt(rng, floor, 99),
    randInt(rng, floor, 99),
  ]
  const stats = {} as PetStats
  order.forEach((key, i) => {
    stats[key] = values[i]
  })
  return stats
}

/** Generate the full deterministic appearance for an account identifier. */
export function generateBones(accountId: string): PetBones {
  const rng = seededRng(PET_BONES_SALT, accountId)

  const species = pick(rng, ALL_PET_SPECIES)
  const rarityEntry = rollRarity(rng())
  const eyes = pick(rng, EYES)
  const shiny = rng() < 0.01
  const hat = pick(rng, HATS_BY_RARITY[rarityEntry.rarity])
  const bodyType = pick(rng, BODY_TYPES)
  const hue = Math.floor(rng() * 360)
  const stats = rollStats(rng, rarityEntry.floor)

  return {
    species,
    rarity: rarityEntry.rarity,
    stars: rarityEntry.stars,
    eyes,
    hat,
    shiny,
    bodyType,
    palette: paletteFromHue(hue),
    stats,
  }
}

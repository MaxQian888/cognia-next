// Per-species visual traits. Instead of 18 bespoke SVGs, one parametric skeleton
// reads these traits (+ the bones palette) to produce distinct silhouettes. This
// keeps the renderer single-file and lets bones drive appearance directly.

import type { PetSpecies } from "@/types/pet"

export type PetEarType = "none" | "cat" | "rabbit" | "round" | "tuft" | "fin" | "antenna"
export type PetTailType = "none" | "curl" | "puff" | "point" | "fan"
export type PetFaceType = "round" | "beak" | "snout" | "blob"

export interface PetSpeciesTraits {
  ears: PetEarType
  tail: PetTailType
  face: PetFaceType
  /** Cheeks/blush accent for cuteness. */
  cheeks: boolean
  /** A floor on body roundness (0 = can be tall, 1 = always round). */
  roundness: number
}

const TRAITS: Record<PetSpecies, PetSpeciesTraits> = {
  duck: { ears: "none", tail: "fan", face: "beak", cheeks: true, roundness: 0.7 },
  cat: { ears: "cat", tail: "curl", face: "snout", cheeks: true, roundness: 0.5 },
  rabbit: { ears: "rabbit", tail: "puff", face: "round", cheeks: true, roundness: 0.6 },
  owl: { ears: "tuft", tail: "none", face: "beak", cheeks: false, roundness: 0.8 },
  penguin: { ears: "none", tail: "none", face: "beak", cheeks: true, roundness: 0.6 },
  turtle: { ears: "none", tail: "point", face: "snout", cheeks: false, roundness: 0.9 },
  fox: { ears: "cat", tail: "fan", face: "snout", cheeks: true, roundness: 0.4 },
  dragon: { ears: "tuft", tail: "point", face: "snout", cheeks: false, roundness: 0.3 },
  axolotl: { ears: "antenna", tail: "fan", face: "round", cheeks: true, roundness: 0.7 },
  blob: { ears: "none", tail: "none", face: "blob", cheeks: true, roundness: 1 },
  cactus: { ears: "none", tail: "none", face: "round", cheeks: true, roundness: 0.4 },
  mushroom: { ears: "none", tail: "none", face: "round", cheeks: true, roundness: 0.5 },
  capybara: { ears: "round", tail: "none", face: "snout", cheeks: false, roundness: 0.5 },
  robot: { ears: "antenna", tail: "none", face: "round", cheeks: false, roundness: 0.2 },
  ghost: { ears: "none", tail: "none", face: "blob", cheeks: true, roundness: 0.9 },
  octopus: { ears: "none", tail: "fan", face: "round", cheeks: true, roundness: 0.8 },
  snail: { ears: "antenna", tail: "curl", face: "round", cheeks: true, roundness: 0.7 },
  chonk: { ears: "round", tail: "puff", face: "round", cheeks: true, roundness: 0.95 },
}

export function getSpeciesTraits(species: PetSpecies): PetSpeciesTraits {
  return TRAITS[species]
}

/** All species keys — useful for the dex grid and exhaustive tests. */
export const ALL_PET_SPECIES = Object.keys(TRAITS) as PetSpecies[]

// Pure VFX-selection for the evolution flavor (care-quality tier stamped at
// evolution) — the flavor sibling of `rarity-vfx.ts`. Radiant pets earn a warm
// accent aura; plain pets render slightly desaturated. Normal (or unset) means
// no flavor layer at all. The saturation shift survives reduced motion (it is
// a static filter, not motion); the aura does not.

import type { PetEvolutionFlavor } from "@/types/pet"
import type { VfxOpts } from "./rarity-vfx"

export interface FlavorVfxDescriptor {
  /** Render the warm accent aura ring (radiant only, motion allowed). */
  aura: boolean
  /** Aura stroke color (literal — visual only, no i18n). */
  auraColor: string
  /** CSS saturate() applied to the whole pet body group. */
  saturate: number
}

/** Warm gold, distinct from the legendary rarity aura. */
const RADIANT_AURA_COLOR = "#fde68a"
const PLAIN_SATURATE = 0.88

/** Flavor flourish, or null when the tier earns none. */
export function resolveFlavorVfx(
  flavor: PetEvolutionFlavor | undefined,
  opts: VfxOpts
): FlavorVfxDescriptor | null {
  if (!flavor || flavor === "normal") return null
  if (flavor === "plain") {
    return { aura: false, auraColor: "transparent", saturate: PLAIN_SATURATE }
  }
  return {
    aura: !opts.reducedMotion,
    auraColor: RADIANT_AURA_COLOR,
    saturate: 1,
  }
}

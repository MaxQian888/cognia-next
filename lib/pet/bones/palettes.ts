// A small curated set of cosmetic palette presets for the in-app "Look" editor.
// Built from the same `paletteFromHue` helper the genetic generator uses, so a
// chosen swatch sits in the same colour space as a naturally-rolled palette.

import type { PetPalette } from "@/types/pet"
import { paletteFromHue } from "./generate"

export interface PetPalettePreset {
  /** Stable id (also the i18n key under `pet.customize.cosmetic.paletteOptions`). */
  id: string
  hue: number
  palette: PetPalette
}

const HUES: { id: string; hue: number }[] = [
  { id: "rose", hue: 12 },
  { id: "amber", hue: 70 },
  { id: "lime", hue: 130 },
  { id: "teal", hue: 185 },
  { id: "sky", hue: 230 },
  { id: "violet", hue: 285 },
  { id: "magenta", hue: 330 },
  { id: "slate", hue: 250 },
]

export const PALETTE_PRESETS: PetPalettePreset[] = HUES.map(({ id, hue }) => ({
  id,
  hue,
  palette: paletteFromHue(hue),
}))

/** Find the preset id whose palette matches `palette` (by primary), if any. */
export function matchPalettePreset(palette: PetPalette | undefined): string | null {
  if (!palette) return null
  return PALETTE_PRESETS.find((p) => p.palette.primary === palette.primary)?.id ?? null
}

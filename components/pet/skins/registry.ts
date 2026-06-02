// Skin registry — the reserved seam for alternative renderers. Only the SVG skin
// ships today; a Lottie/Rive/sprite skin could register here later without the
// state or event layers changing. `getSkin` always falls back to the SVG skin so
// the renderer can never end up with nothing to draw.

import type { PetSkin } from "@/types/pet"
import { svgSkin } from "./svg-skin"

export const DEFAULT_SKIN_ID = "svg"

const skins = new Map<string, PetSkin>([[svgSkin.id, svgSkin]])

export function registerSkin(skin: PetSkin): void {
  skins.set(skin.id, skin)
}

export function getSkin(id: string | undefined): PetSkin {
  return (id && skins.get(id)) || svgSkin
}

export function listSkinIds(): string[] {
  return [...skins.keys()]
}

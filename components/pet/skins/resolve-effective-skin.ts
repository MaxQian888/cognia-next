// Pure selection-time fallback: Live2D requires a ready runtime and active
// model. The sprite boundary owns its reactive asset lookup. Any gap degrades
// to the always-available SVG skin, so the renderer always has something to draw.

import type { PetSkinId, PetSkinSelection } from "@/types/pet"
import {
  normalizePetSkinSelection,
  type NormalizedPetSkinSelection,
} from "@/lib/pet/skin-governance"

export interface EffectiveSkinOpts {
  /** Whether the Cubism Core runtime probe resolved true. */
  coreReady: boolean | undefined
  /** Whether an active Live2D model is configured. */
  hasActiveModel: boolean
  /** False when persisted compatibility validation classified it invalid. */
  modelReady?: boolean
  /** Whether the selected v2 sprite pack still exists in local storage. */
  hasActiveSpritePack?: boolean
}

export function resolveEffectiveSkin(
  skinId: string | undefined,
  opts: EffectiveSkinOpts
): PetSkinId {
  return normalizePetSkinSelection(skinId, {
    modelId: opts.hasActiveModel ? "__active__" : undefined,
    coreReady: opts.coreReady === true,
    modelReady: opts.modelReady,
    packId: opts.hasActiveSpritePack === false ? undefined : "__active__",
    packReady: opts.hasActiveSpritePack,
  }).selection.skinId
}

/** Resolve the durable asset and preserve actionable fallback diagnostics. */
export function resolveEffectiveSkinSelection(
  skinId: string | undefined,
  opts: EffectiveSkinOpts,
  assets: { modelId?: string; packId?: string }
): NormalizedPetSkinSelection {
  return normalizePetSkinSelection(skinId, {
    modelId: opts.hasActiveModel ? assets.modelId : undefined,
    coreReady: opts.coreReady === true,
    modelReady: opts.modelReady,
    packId: opts.hasActiveSpritePack === false ? undefined : assets.packId,
    packReady: opts.hasActiveSpritePack,
  })
}

/** Turn the already-governed effective family into the asset-carrying contract. */
export function selectionFromEffectiveSkin(
  skinId: PetSkinId,
  assets: { modelId?: string; packId?: string }
): PetSkinSelection {
  if (skinId === "live2d" && assets.modelId) return { skinId, modelId: assets.modelId }
  if (skinId === "sprite-v2" && assets.packId) return { skinId, packId: assets.packId }
  return { skinId: "svg" }
}

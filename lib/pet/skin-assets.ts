import { getPetModel, getPetModelEntries, type PetModelRow } from "@/lib/db/pet-models"
import { getPetSpritePack, type PetSpritePackRow } from "@/lib/db/pet-sprite-packs"
import { getPetSkinRuntime } from "./skin-runtime"

export interface Live2dSkinAsset {
  row: PetModelRow
  entries: Array<{ path: string; blob: Blob }>
}

export function loadLive2dSkinAsset(modelId: string): Promise<Live2dSkinAsset | undefined> {
  return getPetSkinRuntime().loadAsset(`live2d:${modelId}`, async () => {
    const [row, entries] = await Promise.all([getPetModel(modelId), getPetModelEntries(modelId)])
    return row ? { row, entries } : undefined
  })
}

export function loadSpriteSkinAsset(packId: string): Promise<PetSpritePackRow | undefined> {
  return getPetSkinRuntime().loadAsset(`sprite-v2:${packId}`, () => getPetSpritePack(packId))
}

export function invalidatePetSkinAsset(
  selection: { skinId: "live2d"; modelId: string } | { skinId: "sprite-v2"; packId: string }
): void {
  getPetSkinRuntime().invalidateAsset(
    selection.skinId === "live2d" ? `live2d:${selection.modelId}` : `sprite-v2:${selection.packId}`
  )
}

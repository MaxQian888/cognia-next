import { getPetModel, getPetModelEntries, type PetModelRow } from "@/lib/db/pet-models"
import { getPetSpritePack, type PetSpritePackRow } from "@/lib/db/pet-sprite-packs"
import { getPetSkinRuntime } from "./skin-runtime"
import {
  getMirroredLive2dRow,
  isLive2dAssetMirror,
  requestMirroredLive2dAsset,
} from "./live2d/asset-bridge"

export interface Live2dSkinAsset {
  row: PetModelRow
  entries: Array<{ path: string; blob: Blob }>
}

export async function loadLive2dSkinAsset(modelId: string): Promise<Live2dSkinAsset | undefined> {
  if (isLive2dAssetMirror()) {
    const runtime = getPetSkinRuntime()
    const key = `live2d:${modelId}`
    const entries = await runtime.loadAsset(
      key,
      async () => (await requestMirroredLive2dAsset(modelId))?.entries
    )
    if (!entries) return undefined
    const row = getMirroredLive2dRow(modelId)
    return row ? { row, entries } : undefined
  }
  // File blobs are immutable between imports, but saved model customization is
  // mutable. Cache only the expensive blobs so every load sees current metadata.
  const [row, entries] = await Promise.all([
    getPetModel(modelId),
    getPetSkinRuntime().loadAsset(`live2d:${modelId}`, () => getPetModelEntries(modelId)),
  ])
  return row ? { row, entries } : undefined
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

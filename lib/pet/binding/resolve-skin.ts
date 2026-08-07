import type { PetCharacterBinding, PetSettings, PetSkinSelection } from "@/types/pet"

export function migrateLegacyPetBinding(
  binding: PetCharacterBinding,
  updatedAt = new Date().toISOString()
): PetCharacterBinding {
  if (binding.skin || !binding.live2dModelId) return binding
  return {
    ...binding,
    skin: { skinId: "live2d", modelId: binding.live2dModelId },
    updatedAt,
  }
}

export function resolveCharacterSkinSelection(
  settings: Pick<PetSettings, "skinId" | "activeLive2dModelId" | "activeSpritePackId">,
  binding: PetCharacterBinding | null | undefined
): PetSkinSelection {
  const migrated = binding ? migrateLegacyPetBinding(binding) : undefined
  if (migrated?.skin) return migrated.skin
  if (settings.skinId === "live2d" && settings.activeLive2dModelId) {
    return { skinId: "live2d", modelId: settings.activeLive2dModelId }
  }
  if (settings.skinId === "sprite-v2" && settings.activeSpritePackId) {
    return { skinId: "sprite-v2", packId: settings.activeSpritePackId }
  }
  return { skinId: "svg" }
}

import { getDb } from "./schema"
import { validateMediaAsset, type MediaPackAsset } from "@/lib/pet/media-packs/manifest"

export interface PetMediaPackRow extends MediaPackAsset {
  displayName: string
}

export async function listPetMediaPacks(): Promise<Array<Omit<PetMediaPackRow, "entries">>> {
  return (await getDb().petMediaPacks.orderBy("createdAt").toArray()).map(
    ({ entries: _entries, ...row }) => row
  )
}
export function getPetMediaPack(id: string): Promise<PetMediaPackRow | undefined> {
  return getDb().petMediaPacks.get(id)
}
export async function addPetMediaPack(asset: MediaPackAsset): Promise<PetMediaPackRow> {
  if (!validateMediaAsset(asset)) throw new Error("Invalid media pack")
  const row = { ...asset, displayName: asset.manifest.displayName }
  await getDb().petMediaPacks.add(row)
  return row
}
export async function deletePetMediaPack(id: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.petMediaPacks, db.settings, db.petCharacterBindings, async () => {
    const settings = await db.settings.get("singleton")
    if (settings?.petSettings?.activeMediaPackId === id)
      await db.settings.put({
        ...settings,
        updatedAt: Date.now(),
        petSettings: {
          ...settings.petSettings,
          skinId: settings.petSettings.skinId === "media" ? "svg" : settings.petSettings.skinId,
          activeMediaPackId: undefined,
        },
      })
    for (const binding of await db.petCharacterBindings.toArray())
      if (binding.skin?.skinId === "media" && binding.skin.packId === id)
        await db.petCharacterBindings.put({
          ...binding,
          skin: undefined,
          updatedAt: new Date().toISOString(),
        })
    await db.petMediaPacks.delete(id)
  })
  const { getPetSkinRuntime } = await import("@/lib/pet/skin-runtime")
  getPetSkinRuntime().invalidateAsset(`media:${id}`)
}

"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { getPetSpritePack, type PetSpritePackRow } from "@/lib/db/pet-sprite-packs"
import type { PetSettings } from "@/types/pet"

export interface ActiveSpritePack {
  packId: string | undefined
  row: PetSpritePackRow | undefined
}

/** Reactively resolve the locally installed v2 sprite pack selected in settings. */
export function useActiveSpritePack(
  settings: Pick<PetSettings, "activeSpritePackId">
): ActiveSpritePack {
  const packId = settings.activeSpritePackId
  const row = useLiveQuery(
    () => (packId ? getPetSpritePack(packId) : Promise.resolve(undefined)),
    [packId],
    undefined
  )
  return { packId, row }
}

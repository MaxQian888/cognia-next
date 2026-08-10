// Binding tab: give each Character its own pet species. Overrides are cosmetic
// (the global rarity/stats are kept) and apply when that character is active.

"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import { listPetBindings, upsertPetBinding, deletePetBinding } from "@/lib/db/pet"
import { listPetModels } from "@/lib/db/pet-models"
import { listPetSpritePacks } from "@/lib/db/pet-sprite-packs"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { PetCharacterBinding, PetSkinSelection, PetSpecies } from "@/types/pet"

function selectionValue(binding: PetCharacterBinding | undefined): string {
  if (binding?.skin?.skinId === "svg") return "svg"
  if (binding?.skin?.skinId === "live2d") return `live2d:${binding.skin.modelId}`
  if (binding?.skin?.skinId === "sprite-v2") return `sprite-v2:${binding.skin.packId}`
  return binding?.live2dModelId ? `live2d:${binding.live2dModelId}` : ""
}

function parseSelection(value: string): PetSkinSelection | undefined {
  if (value === "svg") return { skinId: "svg" }
  if (value.startsWith("live2d:")) return { skinId: "live2d", modelId: value.slice(7) }
  if (value.startsWith("sprite-v2:")) return { skinId: "sprite-v2", packId: value.slice(10) }
  return undefined
}

export function BindingTab() {
  const t = useTranslations("pet")
  const characters = useLiveQuery(() => getDb().characters.toArray(), [])
  const bindings = useLiveQuery(() => listPetBindings(), [])
  const models = useLiveQuery(() => listPetModels(), [], [])
  const packs = useLiveQuery(() => listPetSpritePacks(), [], [])
  const byCharacter = new Map((bindings ?? []).map((binding) => [binding.characterId, binding]))

  const save = (characterId: string, patch: Partial<PetCharacterBinding>) => {
    const current = byCharacter.get(characterId)
    const next: PetCharacterBinding = {
      ...current,
      ...patch,
      characterId,
      updatedAt: new Date().toISOString(),
    }
    if (!next.species && !next.eyes && !next.hat && !next.bodyType && !next.palette && !next.skin) {
      void deletePetBinding(characterId)
      return
    }
    void upsertPetBinding(next)
  }

  if (!characters || characters.length === 0) {
    return (
      <p data-testid="pet-binding-empty" className="text-sm text-muted-foreground">
        {t("binding.empty")}
      </p>
    )
  }

  return (
    <div data-testid="pet-binding" className="flex flex-col gap-2">
      {characters.map((c) => {
        const binding = byCharacter.get(c.id)
        return (
          <div
            key={c.id}
            data-character={c.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
          >
            <span className="min-w-32 flex-1 truncate text-sm">{c.name}</span>
            <NativeSelect
              aria-label={t("binding.speciesFor", { name: c.name })}
              size="sm"
              value={binding?.species ?? ""}
              onChange={(e) => save(c.id, { species: (e.target.value || undefined) as PetSpecies })}
            >
              <NativeSelectOption value="">{t("binding.useGlobal")}</NativeSelectOption>
              {ALL_PET_SPECIES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {t(`species.${s}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t("binding.skinFor", { name: c.name })}
              size="sm"
              wrapperClassName="max-w-52"
              className="max-w-52"
              value={selectionValue(binding)}
              onChange={(event) =>
                save(c.id, {
                  skin: parseSelection(event.target.value),
                  live2dModelId: undefined,
                })
              }
            >
              <NativeSelectOption value="">{t("binding.inheritAppearance")}</NativeSelectOption>
              <NativeSelectOption value="svg">{t("binding.useSvg")}</NativeSelectOption>
              {models.map((model) => (
                <NativeSelectOption key={model.id} value={`live2d:${model.id}`}>
                  {t("binding.live2dOption", { name: model.name })}
                </NativeSelectOption>
              ))}
              {packs.map((pack) => (
                <NativeSelectOption key={pack.id} value={`sprite-v2:${pack.id}`}>
                  {t("binding.spriteOption", { name: pack.displayName })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {binding && (
              <Button size="sm" variant="ghost" onClick={() => void deletePetBinding(c.id)}>
                {t("binding.clear")}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}

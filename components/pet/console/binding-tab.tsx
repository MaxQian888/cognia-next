"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { UsersIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { deletePetBinding, listPetBindings, upsertPetBinding } from "@/lib/db/pet"
import { listPetModels } from "@/lib/db/pet-models"
import { listPetSpritePacks } from "@/lib/db/pet-sprite-packs"
import { getDb } from "@/lib/db/schema"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"
import type { PetCharacterBinding, PetSkinSelection, PetSpecies } from "@/types/pet"

const INHERIT = "__inherit__"
const GLOBAL_SPECIES = "__global__"

function selectionValue(binding: PetCharacterBinding | undefined): string {
  if (binding?.skin?.skinId === "svg") return "svg"
  if (binding?.skin?.skinId === "live2d") return `live2d:${binding.skin.modelId}`
  if (binding?.skin?.skinId === "sprite-v2") return `sprite-v2:${binding.skin.packId}`
  return binding?.live2dModelId ? `live2d:${binding.live2dModelId}` : INHERIT
}

function parseSelection(value: string | null): PetSkinSelection | undefined {
  if (!value || value === INHERIT) return undefined
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
      <Empty data-testid="pet-binding-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyDescription>{t("binding.empty")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ItemGroup data-testid="pet-binding">
      {characters.map((character, index) => {
        const binding = byCharacter.get(character.id)
        const skinValue = selectionValue(binding)
        const skinLabel =
          skinValue === INHERIT
            ? t("binding.inheritAppearance")
            : skinValue === "svg"
              ? t("binding.useSvg")
              : (models.find((model) => `live2d:${model.id}` === skinValue)?.name ??
                packs.find((pack) => `sprite-v2:${pack.id}` === skinValue)?.displayName ??
                t("binding.inheritAppearance"))

        return (
          <div key={character.id} className="contents">
            {index > 0 ? <ItemSeparator /> : null}
            <Item data-character={character.id} className="px-0">
              <ItemContent className="min-w-32">
                <ItemTitle className="truncate">{character.name}</ItemTitle>
              </ItemContent>
              <ItemActions className="w-full flex-wrap @xl/pet-pane:w-auto">
                <Select
                  value={binding?.species ?? GLOBAL_SPECIES}
                  onValueChange={(species) =>
                    save(character.id, {
                      species: species === GLOBAL_SPECIES ? undefined : (species as PetSpecies),
                    })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="min-w-40"
                    aria-label={t("binding.speciesFor", { name: character.name })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={GLOBAL_SPECIES}>{t("binding.useGlobal")}</SelectItem>
                      {ALL_PET_SPECIES.map((species) => (
                        <SelectItem key={species} value={species}>
                          {t(`species.${species}`)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>

                <Combobox
                  value={skinValue}
                  onValueChange={(value: string | null) =>
                    save(character.id, {
                      skin: parseSelection(value),
                      live2dModelId: undefined,
                    })
                  }
                >
                  <ComboboxInput
                    aria-label={t("binding.skinFor", { name: character.name })}
                    placeholder={skinLabel}
                    className="min-w-48"
                  />
                  <ComboboxContent>
                    <ComboboxList>
                      <ComboboxEmpty>{t("binding.inheritAppearance")}</ComboboxEmpty>
                      <ComboboxItem value={INHERIT}>{t("binding.inheritAppearance")}</ComboboxItem>
                      <ComboboxItem value="svg">{t("binding.useSvg")}</ComboboxItem>
                      {models.map((model) => (
                        <ComboboxItem key={model.id} value={`live2d:${model.id}`}>
                          {t("binding.live2dOption", { name: model.name })}
                        </ComboboxItem>
                      ))}
                      {packs.map((pack) => (
                        <ComboboxItem key={pack.id} value={`sprite-v2:${pack.id}`}>
                          {t("binding.spriteOption", { name: pack.displayName })}
                        </ComboboxItem>
                      ))}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                {binding ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void deletePetBinding(character.id)}
                  >
                    {t("binding.clear")}
                  </Button>
                ) : null}
              </ItemActions>
            </Item>
          </div>
        )
      })}
    </ItemGroup>
  )
}

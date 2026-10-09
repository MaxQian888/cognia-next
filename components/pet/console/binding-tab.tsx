// Characters tab: per-character pet overrides (species and skin). A session
// whose character has a binding shows that look instead of the global one.
//
// Reads through `listPetBindingsWithCharacters` (one query, one loading
// state) instead of the raw character table, so pack characters and variants
// appear the way the rest of the app names them. Every write reports its
// failure, and clearing a character's whole binding asks first: it drops the
// species and the skin together.
//
// Read-only when caring for the desktop pet from a paired phone (ADR-0219):
// the bindings are mirrored so the phone can show them, but editing one is a
// desktop write no `pet_*` arm carries, and the Live2D models and sprite packs
// a binding names exist only on the desktop. The rows then state each
// character's look as text, under a line saying where to change it.

"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { MonitorIcon, UsersIcon } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
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
import { deletePetBinding, listPetBindingsWithCharacters, upsertPetBinding } from "@/lib/db/pet"
import { listPetModels } from "@/lib/db/pet-models"
import { listPetSpritePacks } from "@/lib/db/pet-sprite-packs"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"
import type { PetCharacterBinding, PetSkinSelection, PetSpecies } from "@/types/pet"
import { PetTabSkeleton } from "./pet-console-skeleton"

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

export interface BindingTabProps {
  /** Show the bindings without edit controls (remote care, ADR-0219). */
  readOnly?: boolean
}

export function BindingTab({ readOnly = false }: BindingTabProps = {}) {
  const t = useTranslations("pet")
  const data = useLiveQuery(() => listPetBindingsWithCharacters(), [])
  const models = useLiveQuery(() => listPetModels(), [])
  const packs = useLiveQuery(() => listPetSpritePacks(), [])
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())

  if (data === undefined || models === undefined || packs === undefined) {
    return <PetTabSkeleton testId="pet-binding-loading" count={4} />
  }

  const { characters, bindings } = data
  const byCharacter = new Map(bindings.map((binding) => [binding.characterId, binding]))

  const track = async (characterId: string, write: () => Promise<unknown>) => {
    setPending((prev) => new Set(prev).add(characterId))
    try {
      await write()
    } catch {
      toast.error(t("binding.saveFailed"))
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(characterId)
        return next
      })
    }
  }

  const save = (characterId: string, patch: Partial<PetCharacterBinding>) => {
    const current = byCharacter.get(characterId)
    const next: PetCharacterBinding = {
      ...current,
      ...patch,
      characterId,
      updatedAt: new Date().toISOString(),
    }
    // Nothing left to override: the binding goes rather than lingering empty.
    if (!next.species && !next.eyes && !next.hat && !next.bodyType && !next.palette && !next.skin) {
      void track(characterId, () => deletePetBinding(characterId))
      return
    }
    void track(characterId, () => upsertPetBinding(next))
  }

  const clear = (characterId: string, name: string) =>
    void track(characterId, async () => {
      await deletePetBinding(characterId)
      toast.success(t("binding.cleared", { name }))
    })

  if (characters.length === 0) {
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

  // The look a read-only row names. A model or pack this device does not hold
  // (they stay on the desktop) is named by its kind rather than misread as
  // "inherit".
  const readOnlySkinLabel = (value: string): string => {
    if (value === INHERIT) return t("binding.inheritAppearance")
    if (value === "svg") return t("binding.useSvg")
    if (value.startsWith("live2d:")) {
      const name = models.find((model) => `live2d:${model.id}` === value)?.name
      return name ? t("binding.live2dOption", { name }) : t("console.remote.binding.live2d")
    }
    const name = packs.find((pack) => `sprite-v2:${pack.id}` === value)?.displayName
    return name ? t("binding.spriteOption", { name }) : t("console.remote.binding.sprite")
  }

  if (readOnly) {
    return (
      <div data-testid="pet-binding" data-read-only className="flex flex-col gap-3">
        <p
          data-testid="pet-binding-read-only"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <MonitorIcon className="size-4 shrink-0" aria-hidden />
          {t("console.remote.binding.readOnly")}
        </p>
        <ItemGroup>
          {characters.map((character, index) => {
            const binding = byCharacter.get(character.id)
            return (
              <div key={character.id} className="contents">
                {index > 0 ? <ItemSeparator /> : null}
                <Item data-character={character.id} className="px-0">
                  <ItemContent className="min-w-32">
                    <ItemTitle className="truncate">{character.name}</ItemTitle>
                  </ItemContent>
                  <ItemContent className="items-end text-right text-sm text-muted-foreground">
                    <span>
                      {binding?.species ? t(`species.${binding.species}`) : t("binding.useGlobal")}
                    </span>
                    <span>{readOnlySkinLabel(selectionValue(binding))}</span>
                  </ItemContent>
                </Item>
              </div>
            )
          })}
        </ItemGroup>
      </div>
    )
  }

  return (
    <ItemGroup data-testid="pet-binding">
      {characters.map((character, index) => {
        const binding = byCharacter.get(character.id)
        const busy = pending.has(character.id)
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
                  disabled={busy}
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
                  disabled={busy}
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
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" variant="ghost" disabled={busy}>
                        {t("binding.clear")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("binding.clearConfirm.title", { name: character.name })}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("binding.clearConfirm.description")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("binding.clearConfirm.cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          onClick={() => clear(character.id, character.name)}
                        >
                          {t("binding.clearConfirm.confirm")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}
              </ItemActions>
            </Item>
          </div>
        )
      })}
    </ItemGroup>
  )
}

// Binding tab: give each Character its own pet species. Overrides are cosmetic
// (the global rarity/stats are kept) and apply when that character is active.

"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import { listPetBindings, upsertPetBinding, deletePetBinding } from "@/lib/db/pet"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"
import { Button } from "@/components/ui/button"
import type { PetSpecies } from "@/types/pet"

export function BindingTab() {
  const t = useTranslations("pet")
  const characters = useLiveQuery(() => getDb().characters.toArray(), [])
  const bindings = useLiveQuery(() => listPetBindings(), [])
  const bySpecies = new Map((bindings ?? []).map((b) => [b.characterId, b.species]))

  if (!characters || characters.length === 0) {
    return (
      <p data-testid="pet-binding-empty" className="text-sm text-muted-foreground">
        {t("binding.empty")}
      </p>
    )
  }

  return (
    <div data-testid="pet-binding" className="flex flex-col gap-2">
      {characters.map((c) => (
        <div
          key={c.id}
          data-character={c.id}
          className="flex items-center gap-2 rounded-lg border p-2"
        >
          <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
          <select
            aria-label={t("binding.speciesFor", { name: c.name })}
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={bySpecies.get(c.id) ?? ""}
            onChange={(e) => {
              const value = e.target.value
              if (!value) {
                void deletePetBinding(c.id)
              } else {
                void upsertPetBinding({
                  characterId: c.id,
                  species: value as PetSpecies,
                  updatedAt: new Date().toISOString(),
                })
              }
            }}
          >
            <option value="">{t("binding.useGlobal")}</option>
            {ALL_PET_SPECIES.map((s) => (
              <option key={s} value={s}>
                {t(`species.${s}`)}
              </option>
            ))}
          </select>
          {bySpecies.has(c.id) && (
            <Button size="sm" variant="ghost" onClick={() => void deletePetBinding(c.id)}>
              {t("binding.clear")}
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

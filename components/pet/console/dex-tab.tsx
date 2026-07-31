// 图鉴 / Dex tab: the pet gallery. Two sections — the user's imported Live2D
// models (a real picker: tap one to make it the active pet, which switches the
// skin for you) and the built-in species showcase, themed with the palette and
// highlighting the owned one. The Live2D section is why an imported model now
// actually shows up in the "pet list"; before, this tab only knew about SVG
// species.

"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { SparklesIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"
import { listPetModels, type PetModelRow } from "@/lib/db/pet-models"
import { useSettingsStore } from "@/stores/settings"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { DEFAULT_PET_SETTINGS, type PetBones } from "@/types/pet"
import { PetRenderer } from "../pet-renderer"

export function DexTab({ bones }: { bones: PetBones }) {
  const t = useTranslations("pet")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const pet = settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const models = useLiveQuery(() => listPetModels(), [], [] as PetModelRow[])
  const { modelId: activeModelId, coreReady } = useActiveLive2dModel(pet)
  const live2dActive = pet.skinId === "live2d"

  // Tapping a model makes it the active pet — switch to the Live2D skin too, so
  // the choice takes effect immediately instead of silently staying on SVG.
  // (Named without a `use` prefix so they don't read as React hooks.)
  const pickModel = (id: string) =>
    void save({ petSettings: { ...pet, skinId: "live2d", activeLive2dModelId: id } })
  const pickMascot = () => void save({ petSettings: { ...pet, skinId: "svg" } })

  return (
    <div data-testid="pet-dex" className="space-y-6">
      <section className="space-y-3" data-testid="pet-dex-live2d">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t("dex.live2dTitle")}</h3>
          {live2dActive && Boolean(activeModelId) && (
            <Button variant="ghost" size="sm" onClick={pickMascot}>
              {t("dex.useMascot")}
            </Button>
          )}
        </div>
        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dex.live2dEmpty")}</p>
        ) : (
          <div className="grid grid-cols-3 gap-3 @sm/pet-pane:grid-cols-4 @lg/pet-pane:grid-cols-6">
            {models.map((m) => {
              const inUse = live2dActive && activeModelId === m.id
              return (
                <button
                  key={m.id}
                  type="button"
                  data-model={m.id}
                  data-in-use={inUse}
                  aria-pressed={inUse}
                  onClick={() => pickModel(m.id)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-lg border p-2 text-center transition",
                    inUse
                      ? "border-primary bg-primary/5"
                      : "opacity-80 hover:border-primary/50 hover:opacity-100"
                  )}
                >
                  {inUse && coreReady ? (
                    <PetRenderer
                      bones={bones}
                      stage="adult"
                      state="idle"
                      reducedMotion
                      size={56}
                      skinId="live2d"
                    />
                  ) : (
                    <span className="flex size-14 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <SparklesIcon className="size-6" />
                    </span>
                  )}
                  <span className="w-full truncate text-[10px] text-muted-foreground">
                    {m.name}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <section className="space-y-3" data-testid="pet-dex-species">
        <h3 className="text-sm font-medium">{t("dex.speciesTitle")}</h3>
        <div className="grid grid-cols-3 gap-3 @sm/pet-pane:grid-cols-4 @lg/pet-pane:grid-cols-6">
          {ALL_PET_SPECIES.map((species) => {
            const owned = species === bones.species
            const inUse = owned && !live2dActive
            return (
              <div
                key={species}
                data-species={species}
                data-owned={owned}
                data-in-use={inUse}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-lg border p-2",
                  inUse ? "border-primary bg-primary/5" : owned ? "border-primary/60" : "opacity-80"
                )}
              >
                <PetRenderer
                  bones={{ ...bones, species, hat: owned ? bones.hat : "none" }}
                  stage="adult"
                  state="idle"
                  reducedMotion
                  size={56}
                />
                <span className="text-[10px] text-muted-foreground">{t(`species.${species}`)}</span>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

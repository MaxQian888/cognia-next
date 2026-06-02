// 图鉴 / Dex tab: a gallery of every species, themed with the user's palette and
// highlighting the one they own. Read-only showcase.

"use client"

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"
import type { PetBones } from "@/types/pet"
import { PetRenderer } from "../pet-renderer"

export function DexTab({ bones }: { bones: PetBones }) {
  const t = useTranslations("pet")
  return (
    <div data-testid="pet-dex" className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
      {ALL_PET_SPECIES.map((species) => {
        const owned = species === bones.species
        return (
          <div
            key={species}
            data-species={species}
            data-owned={owned}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg border p-2",
              owned ? "border-primary bg-primary/5" : "opacity-80"
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
  )
}

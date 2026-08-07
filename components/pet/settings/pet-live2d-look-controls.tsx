// Live2D "Look" panel — the Live2D counterpart of PetCosmeticControls, shown in
// the Customize tab's Look card whenever the user has chosen the Live2D skin.
// Instead of the SVG palette/hat/eyes controls (which are inert on a Live2D
// model, the source of the "customization is still the built-in pet" bug), it
// previews the ACTIVE model and opens the per-model size/motion editor. When
// Live2D can't render (no model picked / runtime missing / load failed) it says
// exactly why and previews the SVG fallback, so switching skins never leaves the
// user staring at the built-in mascot with no explanation.

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { SlidersHorizontalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { usePet } from "@/hooks/pet/use-pet"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { useActiveSpritePack } from "@/hooks/pet/use-active-sprite-pack"
import { PetModelConfigDialog } from "@/components/settings/pet/pet-model-config-dialog"
import type { PetSettings } from "@/types/pet"
import { resolveEffectiveSkin, selectionFromEffectiveSkin } from "../skins/resolve-effective-skin"
import { PetRenderer } from "../pet-renderer"

export interface PetLive2dLookControlsProps {
  pet: PetSettings
}

export function PetLive2dLookControls({ pet }: PetLive2dLookControlsProps) {
  const t = useTranslations("pet.customize.live2dLook")
  const { profile, view } = usePet()
  const { modelId, row, coreReady } = useActiveLive2dModel(pet)
  const { row: activeSpritePack } = useActiveSpritePack(pet)
  const [configOpen, setConfigOpen] = useState(false)

  if (!profile || !view) return null

  const effectiveSkin = resolveEffectiveSkin(pet.skinId, {
    coreReady,
    hasActiveModel: Boolean(modelId),
    modelReady: row?.compatibility?.status !== "invalid",
    hasActiveSpritePack: Boolean(activeSpritePack),
  })
  const selection = selectionFromEffectiveSkin(effectiveSkin, {
    modelId,
    packId: activeSpritePack?.id,
  })
  // A model is picked but the Cubism runtime is definitively unavailable — the
  // preview is the SVG fallback, so say why it reads as intentional. (While the
  // probe is still resolving, `coreReady` is undefined; stay quiet then.)
  const coreMissing = Boolean(modelId) && coreReady === false

  return (
    <div className="flex flex-col gap-4 sm:flex-row" data-testid="pet-live2d-look-controls">
      <div className="flex items-center justify-center rounded-xl border bg-muted/30 p-4 sm:w-44">
        <PetRenderer
          bones={view.effectiveBones}
          stage={profile.stage}
          state="idle"
          size={120}
          skinId={effectiveSkin}
          selection={selection}
          renderPriority={configOpen ? "thumbnail" : "console"}
          lowPower={pet.lowPower}
        />
      </div>

      <div className="min-w-0 flex-1 space-y-3">
        {row ? (
          <>
            <div>
              <p className="text-xs text-muted-foreground">{t("activeModel")}</p>
              <p className="truncate text-sm font-medium" data-testid="pet-live2d-active-name">
                {row.name}
              </p>
            </div>
            {coreMissing && (
              <p className="text-sm text-destructive" role="status">
                {t("unavailable.coreMissing")}
              </p>
            )}
            <Button variant="outline" size="sm" onClick={() => setConfigOpen(true)}>
              <SlidersHorizontalIcon className="size-4" /> {t("configure")}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noModel")}</p>
        )}

        <p className="text-xs text-muted-foreground">{t("mascotNote")}</p>
      </div>

      {row && configOpen && (
        <PetModelConfigDialog
          // Keyed by model id so each editing session mounts fresh (the dialog
          // seeds its draft from the row at mount — no reseed effect).
          key={row.id}
          model={row}
          open
          onOpenChange={(open) => {
            if (!open) setConfigOpen(false)
          }}
        />
      )}
    </div>
  )
}

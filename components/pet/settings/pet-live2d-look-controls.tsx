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
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemTitle } from "@/components/ui/item"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { PetModelConfigDialog } from "@/components/settings/pet/pet-model-config-dialog"
import type { PetSettings } from "@/types/pet"

export interface PetLive2dLookControlsProps {
  pet: PetSettings
}

export function PetLive2dLookControls({ pet }: PetLive2dLookControlsProps) {
  const t = useTranslations("pet.customize.live2dLook")
  const { modelId, row, coreReady } = useActiveLive2dModel(pet)
  const [configOpen, setConfigOpen] = useState(false)
  // A model is picked but the Cubism runtime is definitively unavailable — the
  // preview is the SVG fallback, so say why it reads as intentional. (While the
  // probe is still resolving, `coreReady` is undefined; stay quiet then.)
  const coreMissing = Boolean(modelId) && coreReady === false

  return (
    <div className="min-w-0 space-y-3" data-testid="pet-live2d-look-controls">
      {row ? (
        <>
          <Item className="px-0">
            <ItemContent className="min-w-0">
              <ItemTitle className="text-xs text-muted-foreground">{t("activeModel")}</ItemTitle>
              <p className="truncate text-sm font-medium" data-testid="pet-live2d-active-name">
                {row.name}
              </p>
            </ItemContent>
            <ItemActions>
              <Button variant="outline" size="sm" onClick={() => setConfigOpen(true)}>
                <SlidersHorizontalIcon className="size-4" /> {t("configure")}
              </Button>
            </ItemActions>
          </Item>
          {coreMissing && (
            <Alert variant="destructive">
              <AlertDescription role="status">{t("unavailable.coreMissing")}</AlertDescription>
            </Alert>
          )}
        </>
      ) : (
        <Empty className="py-6">
          <EmptyDescription>{t("noModel")}</EmptyDescription>
        </Empty>
      )}

      <p className="text-xs text-muted-foreground">{t("mascotNote")}</p>

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

// Appearance controls for the pet: dock anchor, motion preference, skin (SVG vs
// Live2D, with the model manager), and the widget size. Presentational over a
// `{ pet, patch }` interface so both Settings → Pet and the /pet Customize tab
// render identical controls against the same persisted PetSettings.

"use client"

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { useCubismCoreAvailable } from "@/hooks/pet/use-active-live2d-model"
import type { PetAnchor, PetMotionPreference, PetSettings } from "@/types/pet"
import { PetModelManager } from "@/components/settings/pet/pet-model-manager"

const ANCHORS: PetAnchor[] = ["bottom-right", "bottom-left", "top-right", "top-left"]
const MOTIONS: PetMotionPreference[] = ["auto", "full", "reduced"]
const SKINS: string[] = ["svg", "live2d"]

export interface PetControlsProps {
  pet: PetSettings
  patch: (next: Partial<PetSettings>) => void
}

export function PetAppearanceControls({ pet, patch }: PetControlsProps) {
  const t = useTranslations("settings.pet")
  const skinId = pet.skinId ?? "svg"
  // Only inject/probe the core when the user is actually configuring Live2D.
  const coreReady = useCubismCoreAvailable(skinId === "live2d")

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="pet-anchor">{t("anchor.label")}</Label>
        <select
          id="pet-anchor"
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={pet.anchor}
          onChange={(e) => patch({ anchor: e.target.value as PetAnchor })}
        >
          {ANCHORS.map((a) => (
            <option key={a} value={a}>
              {t(`anchor.options.${a}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="pet-motion">{t("motion.label")}</Label>
        <select
          id="pet-motion"
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={pet.motion}
          onChange={(e) => patch({ motion: e.target.value as PetMotionPreference })}
        >
          {MOTIONS.map((m) => (
            <option key={m} value={m}>
              {t(`motion.options.${m}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="pet-skin">{t("skin.label")}</Label>
          <select
            id="pet-skin"
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={skinId}
            onChange={(e) => patch({ skinId: e.target.value })}
          >
            {SKINS.map((s) => (
              <option key={s} value={s}>
                {t(`skin.options.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {skinId === "live2d" && coreReady === false && (
          <p className="text-sm text-destructive">{t("live2d.coreMissing")}</p>
        )}
        {skinId === "live2d" && coreReady === true && !pet.activeLive2dModelId && (
          <p className="text-sm text-muted-foreground">{t("live2d.noModelHint")}</p>
        )}
      </div>

      {skinId === "live2d" && <PetModelManager settings={pet} onPatch={patch} />}

      <div className="space-y-2">
        <Label>{t("size.label", { size: pet.size })}</Label>
        <Slider
          min={64}
          max={144}
          step={8}
          value={[pet.size]}
          onValueChange={([v]) => patch({ size: v })}
        />
      </div>
    </>
  )
}

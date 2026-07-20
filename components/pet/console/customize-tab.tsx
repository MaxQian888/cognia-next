// The /pet console "Customize" tab. Renders the same presentational pet-settings
// controls as Settings → Pet, against the same persisted PetSettings (settings
// store `save()`), so the panel and settings can never drift. Reset + the master
// enable toggle stay in full settings (reachable via the link below).

"use client"

import { useTranslations } from "next-intl"
import {
  BrushIcon,
  MessageCircleIcon,
  Volume2Icon,
  HeartPulseIcon,
  MonitorIcon,
  SettingsIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/platform/detect"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { resolveEffectiveSkin } from "../skins/resolve-effective-skin"
import { PetAppearanceControls } from "../settings/pet-appearance-controls"
import { PetCosmeticControls } from "../settings/pet-cosmetic-controls"
import { PetLive2dLookControls } from "../settings/pet-live2d-look-controls"
import { PetInteractionControls } from "../settings/pet-interaction-controls"
import { PetSoundControls } from "../settings/pet-sound-controls"
import { PetCareControls } from "../settings/pet-care-controls"
import { PetDesktopControls } from "../settings/pet-desktop-controls"

export function CustomizeTab() {
  const t = useTranslations("pet.customize")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const pet: PetSettings = settings?.petSettings ?? DEFAULT_PET_SETTINGS

  const patch = (next: Partial<PetSettings>) => void save({ petSettings: { ...pet, ...next } })

  // Resolve the effective skin so the Look preview matches the live sprite, and
  // swap the SVG cosmetic controls for the Live2D look panel when the user has
  // chosen Live2D — the cosmetic palette/hat/eyes don't touch a Live2D model.
  const { modelId, coreReady } = useActiveLive2dModel(pet)
  const effectiveSkin = resolveEffectiveSkin(pet.skinId, {
    coreReady,
    hasActiveModel: Boolean(modelId),
  })
  const live2dChosen = pet.skinId === "live2d"
  const spriteChosen = pet.skinId === "sprite-v2"

  return (
    <div data-testid="pet-customize-tab" className="mx-auto w-full max-w-3xl space-y-4">
      <SettingsCard
        icon={<BrushIcon className="size-5" />}
        title={t("look.title")}
        description={
          live2dChosen
            ? t("look.descriptionLive2d")
            : spriteChosen
              ? t("look.descriptionSprite")
              : t("look.description")
        }
      >
        {live2dChosen ? (
          <PetLive2dLookControls pet={pet} />
        ) : spriteChosen ? (
          <p className="text-sm text-muted-foreground">{t("look.spriteManagedBelow")}</p>
        ) : (
          <PetCosmeticControls skinId={effectiveSkin} />
        )}
      </SettingsCard>

      <SettingsCard
        icon={<SettingsIcon className="size-5" />}
        title={t("appearance.title")}
        description={t("appearance.description")}
      >
        <PetAppearanceControls pet={pet} patch={patch} />
      </SettingsCard>

      <SettingsCard
        icon={<MessageCircleIcon className="size-5" />}
        title={t("interaction.title")}
        description={t("interaction.description")}
      >
        <PetInteractionControls pet={pet} patch={patch} />
      </SettingsCard>

      <SettingsCard
        icon={<Volume2Icon className="size-5" />}
        title={t("sound.title")}
        description={t("sound.description")}
      >
        <PetSoundControls pet={pet} patch={patch} />
      </SettingsCard>

      <SettingsCard
        icon={<HeartPulseIcon className="size-5" />}
        title={t("care.title")}
        description={t("care.description")}
      >
        <PetCareControls pet={pet} patch={patch} />
      </SettingsCard>

      {isTauri() && (
        <SettingsCard
          icon={<MonitorIcon className="size-5" />}
          title={t("desktop.title")}
          description={t("desktop.description")}
        >
          <PetDesktopControls pet={pet} patch={patch} />
        </SettingsCard>
      )}

      <div className="flex justify-end">
        <Button asChild variant="ghost" size="sm">
          <Link href="/settings?section=pet">{t("openSettings")}</Link>
        </Button>
      </div>
    </div>
  )
}

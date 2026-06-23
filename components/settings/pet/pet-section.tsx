// Settings → Pet. Toggles the subsystem and offers a hard reset; the per-area
// controls (appearance, interaction, sound, care, desktop overlay) are the same
// presentational components the /pet Customize tab renders, so both surfaces
// stay in lockstep against one persisted PetSettings (via the settings store
// `save()`).

"use client"

import { useTranslations } from "next-intl"
import { PawPrintIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { useSettingsStore } from "@/stores/settings"
import { resetPet } from "@/lib/db/pet"
import { isTauri } from "@/lib/platform/detect"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"
import { SettingsCard } from "../common/settings-section"
import { PetAppearanceControls } from "@/components/pet/settings/pet-appearance-controls"
import { PetInteractionControls } from "@/components/pet/settings/pet-interaction-controls"
import { PetSoundControls } from "@/components/pet/settings/pet-sound-controls"
import { PetCareControls } from "@/components/pet/settings/pet-care-controls"
import { PetDesktopControls } from "@/components/pet/settings/pet-desktop-controls"

export function PetSection() {
  const t = useTranslations("settings.pet")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const pet: PetSettings = settings?.petSettings ?? DEFAULT_PET_SETTINGS

  const patch = (next: Partial<PetSettings>) => void save({ petSettings: { ...pet, ...next } })

  return (
    <SettingsCard
      icon={<PawPrintIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="pet-enabled">{t("enabled.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("enabled.description")}</p>
        </div>
        <Switch
          id="pet-enabled"
          checked={pet.enabled}
          onCheckedChange={(v) => patch({ enabled: v })}
        />
      </div>

      <PetAppearanceControls pet={pet} patch={patch} />
      <PetInteractionControls pet={pet} patch={patch} />
      <PetSoundControls pet={pet} patch={patch} />
      <PetCareControls pet={pet} patch={patch} />
      {isTauri() && <PetDesktopControls pet={pet} patch={patch} />}

      <div className="flex items-center justify-between gap-4 border-t pt-4">
        <div className="space-y-0.5">
          <Label>{t("reset.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("reset.description")}</p>
        </div>
        <Button variant="destructive" size="sm" onClick={() => void resetPet()}>
          {t("reset.action")}
        </Button>
      </div>
    </SettingsCard>
  )
}

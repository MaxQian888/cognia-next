// Settings → Pet. Toggles the subsystem, picks the dock corner + motion mode,
// mutes bubbles, sizes the widget, and offers a hard reset. Persists through the
// settings store `save()` action (durable), mirroring the other settings cards.

"use client"

import { useTranslations } from "next-intl"
import { PawPrintIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { useSettingsStore } from "@/stores/settings"
import { resetPet } from "@/lib/db/pet"
import {
  DEFAULT_PET_SETTINGS,
  type PetAnchor,
  type PetMotionPreference,
  type PetSettings,
} from "@/types/pet"
import { SettingsCard } from "../common/settings-section"

const ANCHORS: PetAnchor[] = ["bottom-right", "bottom-left", "top-right", "top-left"]
const MOTIONS: PetMotionPreference[] = ["auto", "full", "reduced"]

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

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="pet-muted">{t("mutedBubbles.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("mutedBubbles.description")}</p>
        </div>
        <Switch
          id="pet-muted"
          checked={pet.mutedBubbles}
          onCheckedChange={(v) => patch({ mutedBubbles: v })}
        />
      </div>

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

// Care + performance controls: low-power rendering mode and the unwell care
// alert. Presentational over the shared `{ pet, patch }` interface.

"use client"

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { PetControlsProps } from "./pet-appearance-controls"

export function PetCareControls({ pet, patch }: PetControlsProps) {
  const t = useTranslations("settings.pet")
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="pet-low-power">{t("lowPower.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("lowPower.description")}</p>
        </div>
        <Switch
          id="pet-low-power"
          checked={pet.lowPower ?? false}
          onCheckedChange={(v) => patch({ lowPower: v })}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="pet-care-alerts">{t("careAlerts.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("careAlerts.description")}</p>
        </div>
        <Switch
          id="pet-care-alerts"
          checked={pet.careAlerts !== false}
          onCheckedChange={(v) => patch({ careAlerts: v })}
        />
      </div>
    </>
  )
}

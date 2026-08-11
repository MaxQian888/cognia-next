// Care + performance controls: low-power rendering mode and the unwell care
// alert. Presentational over the shared `{ pet, patch }` interface.

"use client"

import { useTranslations } from "next-intl"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import type { PetControlsProps } from "./pet-appearance-controls"

export function PetCareControls({ pet, patch }: PetControlsProps) {
  const t = useTranslations("settings.pet")
  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="pet-low-power">{t("lowPower.label")}</FieldLabel>
          <FieldDescription>{t("lowPower.description")}</FieldDescription>
        </FieldContent>
        <Switch
          id="pet-low-power"
          checked={pet.lowPower ?? false}
          onCheckedChange={(v) => patch({ lowPower: v })}
        />
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="pet-care-alerts">{t("careAlerts.label")}</FieldLabel>
          <FieldDescription>{t("careAlerts.description")}</FieldDescription>
        </FieldContent>
        <Switch
          id="pet-care-alerts"
          checked={pet.careAlerts !== false}
          onCheckedChange={(v) => patch({ careAlerts: v })}
        />
      </Field>
    </FieldGroup>
  )
}

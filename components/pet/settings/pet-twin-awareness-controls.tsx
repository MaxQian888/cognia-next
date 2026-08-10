// Ambient Twin-awareness controls: an opt-in switch + a single-twin picker.
// Kept as its own block (not folded into PetInteractionControls) because it's
// the one control that crosses a subsystem boundary — the explanatory copy
// here is a trust-building requirement, not decoration.

"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { listTwins } from "@/lib/db/twins"
import { DEFAULT_PET_TWIN_AWARENESS, type PetTwinAwarenessSettings } from "@/types/pet"
import type { PetControlsProps } from "./pet-appearance-controls"

export function PetTwinAwarenessControls({ pet, patch }: PetControlsProps) {
  const t = useTranslations("settings.pet")
  const twinAwareness: PetTwinAwarenessSettings = pet.twinAwareness ?? DEFAULT_PET_TWIN_AWARENESS
  const patchTwinAwareness = (next: Partial<PetTwinAwarenessSettings>) =>
    patch({ twinAwareness: { ...twinAwareness, ...next } })

  const twins = useLiveQuery(() => listTwins(), [])

  return (
    <div className="space-y-4 border-t pt-4">
      <div className="space-y-0.5">
        <Label>{t("twinAwareness.title")}</Label>
        <p className="text-sm text-muted-foreground">{t("twinAwareness.description")}</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="pet-twin-awareness-enabled">{t("twinAwareness.enabled.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("twinAwareness.enabled.description")}</p>
        </div>
        <Switch
          id="pet-twin-awareness-enabled"
          checked={twinAwareness.enabled}
          onCheckedChange={(v) => patchTwinAwareness({ enabled: v })}
        />
      </div>

      {twinAwareness.enabled && (
        <>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="pet-twin-awareness-twin">{t("twinAwareness.twinSelect.label")}</Label>
            {twins && twins.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("twinAwareness.twinSelect.empty")}</p>
            ) : (
              <NativeSelect
                id="pet-twin-awareness-twin"
                size="sm"
                value={twinAwareness.twinId ?? ""}
                onChange={(e) => patchTwinAwareness({ twinId: e.target.value || null })}
              >
                <NativeSelectOption value="">
                  {t("twinAwareness.twinSelect.placeholder")}
                </NativeSelectOption>
                {(twins ?? []).map((twin) => (
                  <NativeSelectOption key={twin.id} value={twin.id}>
                    {twin.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t("twinAwareness.privacyNote")}</p>
        </>
      )}
    </div>
  )
}

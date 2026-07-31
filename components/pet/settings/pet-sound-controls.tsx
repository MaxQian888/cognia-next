// Sound controls: enable the synthesized SFX, set the volume, and define a
// quiet-hours window (start/end hour) during which sounds stay silent. The
// quiet-hours gate itself already lives in `lib/pet/audio/sfx-gate.ts`; this is
// the editor for the `PetSoundSettings.quietHours` value it consumes.

"use client"

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { DEFAULT_PET_SOUND, type PetSoundSettings, type PetSettings } from "@/types/pet"
import type { PetControlsProps } from "./pet-appearance-controls"

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const DEFAULT_QUIET = { start: 22, end: 7 } as const

const fmtHour = (h: number) => `${String(h).padStart(2, "0")}:00`

export function PetSoundControls({ pet, patch }: PetControlsProps) {
  const t = useTranslations("settings.pet")
  const sound: PetSoundSettings = pet.sound ?? DEFAULT_PET_SOUND
  const patchSound = (next: Partial<PetSoundSettings>) =>
    patch({ sound: { ...sound, ...next } } as Partial<PetSettings>)
  const quiet = sound.quietHours ?? null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="pet-sound-enabled">{t("sound.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("sound.description")}</p>
        </div>
        <Switch
          id="pet-sound-enabled"
          checked={sound.enabled}
          onCheckedChange={(v) => patchSound({ enabled: v })}
        />
      </div>
      {sound.enabled && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>
              {t("sound.volume.label", { value: Math.round((sound.volume ?? 0.5) * 100) })}
            </Label>
            <Slider
              min={0}
              max={100}
              step={5}
              value={[Math.round((sound.volume ?? 0.5) * 100)]}
              onValueChange={([v]) => patchSound({ volume: v / 100 })}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="pet-sound-quiet">{t("sound.quietHours.label")}</Label>
                <p className="text-sm text-muted-foreground">{t("sound.quietHours.description")}</p>
              </div>
              <Switch
                id="pet-sound-quiet"
                checked={!!quiet}
                onCheckedChange={(v) => patchSound({ quietHours: v ? { ...DEFAULT_QUIET } : null })}
              />
            </div>
            {quiet && (
              <div className="flex items-center gap-2" data-testid="pet-quiet-hours">
                <Label htmlFor="pet-quiet-start" className="text-xs text-muted-foreground">
                  {t("sound.quietHours.start")}
                </Label>
                <select
                  id="pet-quiet-start"
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                  value={quiet.start}
                  onChange={(e) =>
                    patchSound({ quietHours: { ...quiet, start: Number(e.target.value) } })
                  }
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {fmtHour(h)}
                    </option>
                  ))}
                </select>
                <Label htmlFor="pet-quiet-end" className="text-xs text-muted-foreground">
                  {t("sound.quietHours.end")}
                </Label>
                <select
                  id="pet-quiet-end"
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                  value={quiet.end}
                  onChange={(e) =>
                    patchSound({ quietHours: { ...quiet, end: Number(e.target.value) } })
                  }
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {fmtHour(h)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

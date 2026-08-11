"use client"

import { useTranslations } from "next-intl"

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { DEFAULT_PET_SOUND, type PetSettings, type PetSoundSettings } from "@/types/pet"

import type { PetControlsProps } from "./pet-appearance-controls"

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)
const DEFAULT_QUIET = { start: 22, end: 7 } as const
const formatHour = (hour: number) => `${String(hour).padStart(2, "0")}:00`

function HourSelect({
  id,
  label,
  value,
  onValueChange,
}: {
  id: string
  label: string
  value: number
  onValueChange: (value: number) => void
}) {
  return (
    <Select value={String(value)} onValueChange={(next) => onValueChange(Number(next))}>
      <SelectTrigger id={id} size="sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {HOURS.map((hour) => (
            <SelectItem key={hour} value={String(hour)}>
              {formatHour(hour)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export function PetSoundControls({ pet, patch }: PetControlsProps) {
  const t = useTranslations("settings.pet")
  const sound: PetSoundSettings = pet.sound ?? DEFAULT_PET_SOUND
  const quiet = sound.quietHours ?? null
  const patchSound = (next: Partial<PetSoundSettings>) =>
    patch({ sound: { ...sound, ...next } } as Partial<PetSettings>)

  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="pet-sound-enabled">{t("sound.label")}</FieldLabel>
          <FieldDescription>{t("sound.description")}</FieldDescription>
        </FieldContent>
        <Switch
          id="pet-sound-enabled"
          checked={sound.enabled}
          onCheckedChange={(enabled) => patchSound({ enabled })}
        />
      </Field>

      {sound.enabled ? (
        <>
          <Field>
            <FieldLabel htmlFor="pet-sound-volume">
              {t("sound.volume.label", { value: Math.round((sound.volume ?? 0.5) * 100) })}
            </FieldLabel>
            <Slider
              id="pet-sound-volume"
              min={0}
              max={100}
              step={5}
              value={[Math.round((sound.volume ?? 0.5) * 100)]}
              onValueChange={([volume]) => patchSound({ volume: volume / 100 })}
            />
          </Field>

          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel htmlFor="pet-sound-quiet">{t("sound.quietHours.label")}</FieldLabel>
              <FieldDescription>{t("sound.quietHours.description")}</FieldDescription>
            </FieldContent>
            <Switch
              id="pet-sound-quiet"
              checked={Boolean(quiet)}
              onCheckedChange={(enabled) =>
                patchSound({ quietHours: enabled ? { ...DEFAULT_QUIET } : null })
              }
            />
          </Field>

          {quiet ? (
            <div className="grid gap-4 @md/field-group:grid-cols-2" data-testid="pet-quiet-hours">
              <Field>
                <FieldLabel htmlFor="pet-quiet-start">{t("sound.quietHours.start")}</FieldLabel>
                <HourSelect
                  id="pet-quiet-start"
                  label={t("sound.quietHours.start")}
                  value={quiet.start}
                  onValueChange={(start) => patchSound({ quietHours: { ...quiet, start } })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="pet-quiet-end">{t("sound.quietHours.end")}</FieldLabel>
                <HourSelect
                  id="pet-quiet-end"
                  label={t("sound.quietHours.end")}
                  value={quiet.end}
                  onValueChange={(end) => patchSound({ quietHours: { ...quiet, end } })}
                />
              </Field>
            </div>
          ) : null}
        </>
      ) : null}
    </FieldGroup>
  )
}

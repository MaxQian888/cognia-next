"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { UsersIcon } from "lucide-react"

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { listTwins } from "@/lib/db/twins"
import { DEFAULT_PET_TWIN_AWARENESS, type PetTwinAwarenessSettings } from "@/types/pet"

import type { PetControlsProps } from "./pet-appearance-controls"

export function PetTwinAwarenessControls({ pet, patch }: PetControlsProps) {
  const t = useTranslations("settings.pet")
  const twinAwareness: PetTwinAwarenessSettings = pet.twinAwareness ?? DEFAULT_PET_TWIN_AWARENESS
  const twins = useLiveQuery(() => listTwins(), [])
  const patchTwinAwareness = (next: Partial<PetTwinAwarenessSettings>) =>
    patch({ twinAwareness: { ...twinAwareness, ...next } })
  const selectedTwin = twins?.find((twin) => twin.id === twinAwareness.twinId)

  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="pet-twin-awareness-enabled">
            {t("twinAwareness.enabled.label")}
          </FieldLabel>
          <FieldDescription>{t("twinAwareness.enabled.description")}</FieldDescription>
        </FieldContent>
        <Switch
          id="pet-twin-awareness-enabled"
          checked={twinAwareness.enabled}
          onCheckedChange={(enabled) => patchTwinAwareness({ enabled })}
        />
      </Field>

      {twinAwareness.enabled ? (
        <>
          {twins && twins.length === 0 ? (
            <Empty className="border-0 p-3">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyDescription>{t("twinAwareness.twinSelect.empty")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Field>
              <FieldLabel htmlFor="pet-twin-awareness-twin">
                {t("twinAwareness.twinSelect.label")}
              </FieldLabel>
              <Combobox
                value={twinAwareness.twinId ?? ""}
                onValueChange={(twinId: string | null) => patchTwinAwareness({ twinId })}
              >
                <ComboboxInput
                  id="pet-twin-awareness-twin"
                  aria-label={t("twinAwareness.twinSelect.label")}
                  placeholder={selectedTwin?.name ?? t("twinAwareness.twinSelect.placeholder")}
                  showClear
                />
                <ComboboxContent>
                  <ComboboxList>
                    <ComboboxEmpty>{t("twinAwareness.twinSelect.empty")}</ComboboxEmpty>
                    {(twins ?? []).map((twin) => (
                      <ComboboxItem key={twin.id} value={twin.id}>
                        {twin.name}
                      </ComboboxItem>
                    ))}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </Field>
          )}
          <FieldDescription>{t("twinAwareness.privacyNote")}</FieldDescription>
        </>
      ) : null}
    </FieldGroup>
  )
}

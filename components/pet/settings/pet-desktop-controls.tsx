"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
  FieldTitle,
} from "@/components/ui/field"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { overlayWindowSize } from "@/lib/pet/overlay-geometry"
import { isLinuxPlatform } from "@/lib/tauri/os"
import { destroyPetWindow, openPetWindow, setPetClickThrough } from "@/lib/tauri/pet-window"
import {
  DEFAULT_PET_DESKTOP_OVERLAY,
  DEFAULT_PET_WANDER,
  type PetDesktopOverlaySettings,
  type PetWanderFrequency,
  type PetWanderRange,
  type PetWanderSettings,
} from "@/types/pet"

import type { PetControlsProps } from "./pet-appearance-controls"

const WANDER_FREQUENCIES: PetWanderFrequency[] = ["calm", "normal", "lively"]
const WANDER_RANGES: PetWanderRange[] = ["full", "near"]

export function PetDesktopControls({ pet, patch }: PetControlsProps) {
  const t = useTranslations("settings.pet")
  const desktopPet: PetDesktopOverlaySettings = pet.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY
  const wander: PetWanderSettings = desktopPet.wander ?? DEFAULT_PET_WANDER
  const climbWindowsSupported = !isLinuxPlatform()

  const patchDesktop = (next: Partial<PetDesktopOverlaySettings>) =>
    patch({ desktopPet: { ...desktopPet, ...next } })
  const patchWander = (next: Partial<PetWanderSettings>) =>
    patchDesktop({ wander: { ...wander, ...next } })

  const handleDesktopEnabled = (enabled: boolean) => {
    patchDesktop({ enabled })
    if (enabled) {
      void openPetWindow({
        ...overlayWindowSize(desktopPet.size),
        x: desktopPet.position?.x,
        y: desktopPet.position?.y,
        clickThrough: desktopPet.clickThrough,
      })
    } else {
      void destroyPetWindow()
    }
  }

  const handleClickThrough = (clickThrough: boolean) => {
    patchDesktop({ clickThrough })
    void setPetClickThrough(clickThrough)
  }

  return (
    <FieldGroup>
      <Field>
        <FieldTitle>{t("desktopPet.title")}</FieldTitle>
        <FieldDescription>{t("desktopPet.description")}</FieldDescription>
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="pet-desktop-enabled">{t("desktopPet.enabled.label")}</FieldLabel>
          <FieldDescription>{t("desktopPet.enabled.description")}</FieldDescription>
        </FieldContent>
        <Switch
          id="pet-desktop-enabled"
          checked={desktopPet.enabled}
          onCheckedChange={handleDesktopEnabled}
        />
      </Field>

      <Button asChild size="sm" variant="link" className="h-auto w-fit p-0">
        <Link href="/settings?section=shortcuts">
          {t("desktopPet.hotkeyLink")}
          <ArrowRightIcon className="size-3.5" />
        </Link>
      </Button>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="pet-desktop-clickthrough">
            {t("desktopPet.clickThrough.label")}
          </FieldLabel>
          <FieldDescription>
            {t("desktopPet.clickThrough.description")} {t("desktopPet.clickThroughHint")}
          </FieldDescription>
        </FieldContent>
        <Switch
          id="pet-desktop-clickthrough"
          checked={desktopPet.clickThrough}
          onCheckedChange={handleClickThrough}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="pet-desktop-size">
          {t("desktopPet.size.label", { size: desktopPet.size })}
        </FieldLabel>
        <Slider
          id="pet-desktop-size"
          min={96}
          max={256}
          step={16}
          value={[desktopPet.size]}
          onValueChange={([size]) => patchDesktop({ size })}
        />
      </Field>

      {desktopPet.enabled ? (
        <div data-testid="pet-wander-block" className="contents">
          <FieldSeparator>{t("desktopPet.wander.title")}</FieldSeparator>
          <Field>
            <FieldTitle>{t("desktopPet.wander.title")}</FieldTitle>
            <FieldDescription>{t("desktopPet.wander.description")}</FieldDescription>
          </Field>

          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel htmlFor="pet-wander-enabled">
                {t("desktopPet.wander.enabled.label")}
              </FieldLabel>
              <FieldDescription>{t("desktopPet.wander.enabled.description")}</FieldDescription>
            </FieldContent>
            <Switch
              id="pet-wander-enabled"
              checked={wander.enabled}
              onCheckedChange={(enabled) => patchWander({ enabled })}
            />
          </Field>

          <Field orientation="responsive">
            <FieldTitle id="pet-wander-frequency-label">
              {t("desktopPet.wander.frequency.label")}
            </FieldTitle>
            <ToggleGroup
              id="pet-wander-frequency"
              type="single"
              value={wander.frequency}
              variant="outline"
              size="sm"
              aria-labelledby="pet-wander-frequency-label"
              onValueChange={(frequency) =>
                frequency && patchWander({ frequency: frequency as PetWanderFrequency })
              }
            >
              {WANDER_FREQUENCIES.map((frequency) => (
                <ToggleGroupItem key={frequency} value={frequency}>
                  {t(`desktopPet.wander.frequency.options.${frequency}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <Field orientation="responsive">
            <FieldTitle id="pet-wander-range-label">
              {t("desktopPet.wander.range.label")}
            </FieldTitle>
            <ToggleGroup
              id="pet-wander-range"
              type="single"
              value={wander.range}
              variant="outline"
              size="sm"
              aria-labelledby="pet-wander-range-label"
              onValueChange={(range) => range && patchWander({ range: range as PetWanderRange })}
            >
              {WANDER_RANGES.map((range) => (
                <ToggleGroupItem key={range} value={range}>
                  {t(`desktopPet.wander.range.options.${range}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel htmlFor="pet-wander-after-interaction">
                {t("desktopPet.wander.onlyAfterInteraction.label")}
              </FieldLabel>
              <FieldDescription>
                {t("desktopPet.wander.onlyAfterInteraction.description")}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="pet-wander-after-interaction"
              checked={wander.onlyAfterInteraction}
              onCheckedChange={(onlyAfterInteraction) => patchWander({ onlyAfterInteraction })}
            />
          </Field>

          <Field orientation="responsive" data-disabled={!climbWindowsSupported}>
            <FieldContent>
              <FieldLabel htmlFor="pet-wander-climb">
                {t("desktopPet.wander.climbWindows.label")}
              </FieldLabel>
              <FieldDescription>
                {climbWindowsSupported
                  ? t("desktopPet.wander.climbWindows.description")
                  : t("desktopPet.wander.climbWindows.unsupportedPlatform")}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="pet-wander-climb"
              checked={climbWindowsSupported && Boolean(wander.climbWindows)}
              disabled={!climbWindowsSupported}
              onCheckedChange={(climbWindows) => patchWander({ climbWindows })}
            />
          </Field>
        </div>
      ) : null}
    </FieldGroup>
  )
}

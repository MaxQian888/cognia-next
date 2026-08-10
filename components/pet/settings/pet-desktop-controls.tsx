// Desktop overlay ("desktop pet") controls — Tauri only. Owns the live window
// side-effects (open/destroy/click-through) alongside the persisted flags, plus
// the wander sub-block. Render this only when `isTauri()`; it assumes the
// desktop shell is present.

"use client"

import { useTranslations } from "next-intl"
import Link from "next/link"
import { ArrowRightIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { destroyPetWindow, openPetWindow, setPetClickThrough } from "@/lib/tauri/pet-window"
import { overlayWindowSize } from "@/lib/pet/overlay-geometry"
import { isLinuxPlatform } from "@/lib/tauri/os"
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

  const patchDesktop = (next: Partial<PetDesktopOverlaySettings>) =>
    patch({ desktopPet: { ...desktopPet, ...next } })

  const wander: PetWanderSettings = desktopPet.wander ?? DEFAULT_PET_WANDER
  const patchWander = (next: Partial<PetWanderSettings>) =>
    patchDesktop({ wander: { ...wander, ...next } })

  // Window-climbing needs cross-app window enumeration — available on
  // Windows and macOS, not on Linux (see `PetWanderSettings.climbWindows`).
  const climbWindowsSupported = !isLinuxPlatform()

  // Toggle the overlay window alongside the persisted flag. Enabling opens the
  // transparent window at the saved size/position; disabling destroys it (which
  // also resets click-through so the user is never left with a stuck overlay).
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
    <div className="space-y-4 border-t pt-4">
      <div className="space-y-0.5">
        <Label>{t("desktopPet.title")}</Label>
        <p className="text-sm text-muted-foreground">{t("desktopPet.description")}</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="pet-desktop-enabled">{t("desktopPet.enabled.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("desktopPet.enabled.description")}</p>
        </div>
        <Switch
          id="pet-desktop-enabled"
          checked={desktopPet.enabled}
          onCheckedChange={handleDesktopEnabled}
        />
      </div>

      <Button asChild size="sm" variant="link" className="h-auto p-0">
        <Link href="/settings?section=shortcuts">
          {t("desktopPet.hotkeyLink")}
          <ArrowRightIcon className="ml-1.5 size-3.5" />
        </Link>
      </Button>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="pet-desktop-clickthrough">{t("desktopPet.clickThrough.label")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("desktopPet.clickThrough.description")}
            </p>
          </div>
          <Switch
            id="pet-desktop-clickthrough"
            checked={desktopPet.clickThrough}
            onCheckedChange={handleClickThrough}
          />
        </div>
        <p className="text-sm text-muted-foreground">{t("desktopPet.clickThroughHint")}</p>
      </div>

      <div className="space-y-2">
        <Label>{t("desktopPet.size.label", { size: desktopPet.size })}</Label>
        <Slider
          min={96}
          max={256}
          step={16}
          value={[desktopPet.size]}
          onValueChange={([v]) => patchDesktop({ size: v })}
        />
      </div>

      {desktopPet.enabled && (
        <div className="space-y-4 border-t pt-4" data-testid="pet-wander-block">
          <div className="space-y-0.5">
            <Label>{t("desktopPet.wander.title")}</Label>
            <p className="text-sm text-muted-foreground">{t("desktopPet.wander.description")}</p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="pet-wander-enabled">{t("desktopPet.wander.enabled.label")}</Label>
              <p className="text-sm text-muted-foreground">
                {t("desktopPet.wander.enabled.description")}
              </p>
            </div>
            <Switch
              id="pet-wander-enabled"
              checked={wander.enabled}
              onCheckedChange={(v) => patchWander({ enabled: v })}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="pet-wander-frequency">{t("desktopPet.wander.frequency.label")}</Label>
            <NativeSelect
              id="pet-wander-frequency"
              size="sm"
              value={wander.frequency}
              onChange={(e) => patchWander({ frequency: e.target.value as PetWanderFrequency })}
            >
              {WANDER_FREQUENCIES.map((f) => (
                <NativeSelectOption key={f} value={f}>
                  {t(`desktopPet.wander.frequency.options.${f}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="pet-wander-range">{t("desktopPet.wander.range.label")}</Label>
            <NativeSelect
              id="pet-wander-range"
              size="sm"
              value={wander.range}
              onChange={(e) => patchWander({ range: e.target.value as PetWanderRange })}
            >
              {WANDER_RANGES.map((r) => (
                <NativeSelectOption key={r} value={r}>
                  {t(`desktopPet.wander.range.options.${r}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="pet-wander-after-interaction">
                {t("desktopPet.wander.onlyAfterInteraction.label")}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t("desktopPet.wander.onlyAfterInteraction.description")}
              </p>
            </div>
            <Switch
              id="pet-wander-after-interaction"
              checked={wander.onlyAfterInteraction}
              onCheckedChange={(v) => patchWander({ onlyAfterInteraction: v })}
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="pet-wander-climb">{t("desktopPet.wander.climbWindows.label")}</Label>
              <p className="text-sm text-muted-foreground">
                {climbWindowsSupported
                  ? t("desktopPet.wander.climbWindows.description")
                  : t("desktopPet.wander.climbWindows.unsupportedPlatform")}
              </p>
            </div>
            <Switch
              id="pet-wander-climb"
              checked={climbWindowsSupported && (wander.climbWindows ?? false)}
              disabled={!climbWindowsSupported}
              onCheckedChange={(v) => patchWander({ climbWindows: v })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

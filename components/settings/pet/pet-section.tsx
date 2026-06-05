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
import { isTauri } from "@/lib/platform/detect"
import { destroyPetWindow, openPetWindow, setPetClickThrough } from "@/lib/tauri/pet-window"
import { overlayWindowSize } from "@/lib/pet/overlay-geometry"
import { useCubismCoreAvailable } from "@/hooks/pet/use-active-live2d-model"
import {
  DEFAULT_PET_DESKTOP_OVERLAY,
  DEFAULT_PET_SETTINGS,
  DEFAULT_PET_WANDER,
  type PetAnchor,
  type PetDesktopOverlaySettings,
  type PetMotionPreference,
  type PetSettings,
  type PetWanderFrequency,
  type PetWanderRange,
  type PetWanderSettings,
} from "@/types/pet"
import { SettingsCard } from "../common/settings-section"
import { ModelOverrideFields, useUtilityProviderOptions } from "../common/model-override-fields"
import type { UtilityModelConfig } from "@/lib/claude/types"
import { PetModelManager } from "./pet-model-manager"

const ANCHORS: PetAnchor[] = ["bottom-right", "bottom-left", "top-right", "top-left"]
const MOTIONS: PetMotionPreference[] = ["auto", "full", "reduced"]
const SKINS: string[] = ["svg", "live2d"]
const WANDER_FREQUENCIES: PetWanderFrequency[] = ["calm", "normal", "lively"]
const WANDER_RANGES: PetWanderRange[] = ["full", "near"]

export function PetSection() {
  const t = useTranslations("settings.pet")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const pet: PetSettings = settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const coreReady = useCubismCoreAvailable()
  const skinId = pet.skinId ?? "svg"
  const desktopPet: PetDesktopOverlaySettings = pet.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY
  const showDesktopPet = isTauri()

  const patch = (next: Partial<PetSettings>) => void save({ petSettings: { ...pet, ...next } })

  // Patch the nested opt-in LLM-speak utility config.
  const providers = useUtilityProviderOptions()
  const patchLlmSpeak = (next: Partial<UtilityModelConfig>) =>
    patch({ llmSpeak: { ...pet.llmSpeak, ...next } })

  // Patch the nested desktop-pet overlay block.
  const patchDesktop = (next: Partial<PetDesktopOverlaySettings>) =>
    patch({ desktopPet: { ...desktopPet, ...next } })

  // Patch the nested wander block (legacy settings may lack it entirely).
  const wander: PetWanderSettings = desktopPet.wander ?? DEFAULT_PET_WANDER
  const patchWander = (next: Partial<PetWanderSettings>) =>
    patchDesktop({ wander: { ...wander, ...next } })

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

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="pet-skin">{t("skin.label")}</Label>
          <select
            id="pet-skin"
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={skinId}
            onChange={(e) => patch({ skinId: e.target.value })}
          >
            {SKINS.map((s) => (
              <option key={s} value={s}>
                {t(`skin.options.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {skinId === "live2d" && coreReady === false && (
          <p className="text-sm text-destructive">{t("live2d.coreMissing")}</p>
        )}
      </div>

      {skinId === "live2d" && <PetModelManager settings={pet} onPatch={patch} />}

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

      {/* Opt-in LLM speak for the talk interaction (off = template bubbles only). */}
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="pet-llm-speak">{t("llmSpeak.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("llmSpeak.description")}</p>
        </div>
        <Switch
          id="pet-llm-speak"
          checked={!!pet.llmSpeak?.enabled}
          onCheckedChange={(v) => patchLlmSpeak({ enabled: v })}
        />
      </div>
      {!!pet.llmSpeak?.enabled && (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-xs text-muted-foreground">{t("llmSpeak.modelHint")}</p>
          <ModelOverrideFields
            value={pet.llmSpeak}
            providers={providers}
            onChange={patchLlmSpeak}
            labels={{
              provider: t("llmSpeak.provider"),
              model: t("llmSpeak.model"),
              useDefault: t("llmSpeak.useDefault"),
            }}
          />
        </div>
      )}

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

      {showDesktopPet && (
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

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="pet-desktop-clickthrough">
                  {t("desktopPet.clickThrough.label")}
                </Label>
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
                <p className="text-sm text-muted-foreground">
                  {t("desktopPet.wander.description")}
                </p>
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
                <Label htmlFor="pet-wander-frequency">
                  {t("desktopPet.wander.frequency.label")}
                </Label>
                <select
                  id="pet-wander-frequency"
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                  value={wander.frequency}
                  onChange={(e) => patchWander({ frequency: e.target.value as PetWanderFrequency })}
                >
                  {WANDER_FREQUENCIES.map((f) => (
                    <option key={f} value={f}>
                      {t(`desktopPet.wander.frequency.options.${f}`)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="pet-wander-range">{t("desktopPet.wander.range.label")}</Label>
                <select
                  id="pet-wander-range"
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                  value={wander.range}
                  onChange={(e) => patchWander({ range: e.target.value as PetWanderRange })}
                >
                  {WANDER_RANGES.map((r) => (
                    <option key={r} value={r}>
                      {t(`desktopPet.wander.range.options.${r}`)}
                    </option>
                  ))}
                </select>
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
            </div>
          )}
        </div>
      )}

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

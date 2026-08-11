"use client"

import { useTranslations } from "next-intl"

import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { PetModelManager } from "@/components/settings/pet/pet-model-manager"
import { PetSpritePackManager } from "@/components/settings/pet/pet-sprite-pack-manager"
import { useCubismCoreAvailable } from "@/hooks/pet/use-active-live2d-model"
import type { PetAnchor, PetMotionPreference, PetSettings, PetSkinId } from "@/types/pet"

const ANCHORS: PetAnchor[] = ["bottom-right", "bottom-left", "top-right", "top-left"]
const MOTIONS: PetMotionPreference[] = ["auto", "full", "reduced"]
const SKINS: PetSkinId[] = ["svg", "live2d", "sprite-v2"]

export interface PetControlsProps {
  pet: PetSettings
  patch: (next: Partial<PetSettings>) => void
}

export function PetAppearanceControls({ pet, patch }: PetControlsProps) {
  const t = useTranslations("settings.pet")
  const skinId = pet.skinId ?? "svg"
  const coreReady = useCubismCoreAvailable(skinId === "live2d")
  const effectiveSkin =
    skinId === "live2d"
      ? coreReady === true && pet.activeLive2dModelId
        ? "live2d"
        : "svg"
      : skinId === "sprite-v2" && !pet.activeSpritePackId
        ? "svg"
        : skinId

  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldTitle id="pet-anchor-label">{t("anchor.label")}</FieldTitle>
        <ToggleGroup
          id="pet-anchor"
          type="single"
          value={pet.anchor}
          variant="outline"
          size="sm"
          className="flex-wrap justify-start"
          aria-labelledby="pet-anchor-label"
          onValueChange={(anchor) => anchor && patch({ anchor: anchor as PetAnchor })}
        >
          {ANCHORS.map((anchor) => (
            <ToggleGroupItem key={anchor} value={anchor}>
              {t(`anchor.options.${anchor}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>

      <Field orientation="responsive">
        <FieldTitle id="pet-motion-label">{t("motion.label")}</FieldTitle>
        <ToggleGroup
          id="pet-motion"
          type="single"
          value={pet.motion}
          variant="outline"
          size="sm"
          className="flex-wrap justify-start"
          aria-labelledby="pet-motion-label"
          onValueChange={(motion) => motion && patch({ motion: motion as PetMotionPreference })}
        >
          {MOTIONS.map((motion) => (
            <ToggleGroupItem key={motion} value={motion}>
              {t(`motion.options.${motion}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="pet-gaze-following">{t("gaze.label")}</FieldLabel>
          <FieldDescription>{t("gaze.description")}</FieldDescription>
        </FieldContent>
        <Switch
          id="pet-gaze-following"
          checked={pet.gazeFollowing ?? true}
          onCheckedChange={(gazeFollowing) => patch({ gazeFollowing })}
        />
      </Field>

      <Field>
        <FieldTitle id="pet-skin-label">{t("skin.label")}</FieldTitle>
        <ToggleGroup
          id="pet-skin"
          type="single"
          value={skinId}
          variant="outline"
          className="flex-wrap justify-start"
          aria-labelledby="pet-skin-label"
          onValueChange={(nextSkinId) => nextSkinId && patch({ skinId: nextSkinId as PetSkinId })}
        >
          {SKINS.map((skin) => (
            <ToggleGroupItem key={skin} value={skin}>
              {t(`skin.options.${skin}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {skinId === "live2d" && coreReady === false ? (
          <Alert variant="destructive">
            <AlertDescription>{t("live2d.coreMissing")}</AlertDescription>
          </Alert>
        ) : null}
        {skinId === "live2d" && coreReady === true && !pet.activeLive2dModelId ? (
          <Alert>
            <AlertDescription>{t("live2d.noModelHint")}</AlertDescription>
          </Alert>
        ) : null}
        <FieldDescription className="flex flex-wrap gap-x-3" data-testid="pet-effective-skin">
          <span>{t("skinStatus.requested", { skin: t(`skin.options.${skinId}`) })}</span>
          <span>{t("skinStatus.effective", { skin: t(`skin.options.${effectiveSkin}`) })}</span>
        </FieldDescription>
      </Field>

      {skinId === "live2d" ? (
        <PetModelManager settings={pet} onPatch={patch} coreReady={coreReady} />
      ) : null}
      {skinId === "sprite-v2" ? <PetSpritePackManager settings={pet} onPatch={patch} /> : null}

      <Field>
        <FieldLabel htmlFor="pet-size">{t("size.label", { size: pet.size })}</FieldLabel>
        <Slider
          id="pet-size"
          min={64}
          max={144}
          step={8}
          value={[pet.size]}
          onValueChange={([size]) => patch({ size })}
        />
      </Field>
    </FieldGroup>
  )
}

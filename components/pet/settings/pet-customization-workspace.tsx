"use client"

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import {
  BrushIcon,
  HeartPulseIcon,
  MessageCircleIcon,
  MonitorIcon,
  PawPrintIcon,
  RotateCcwIcon,
  SettingsIcon,
  SparklesIcon,
  Volume2Icon,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { CapabilityGate } from "@/components/platform/capability-gate"
import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { useActiveSpritePack } from "@/hooks/pet/use-active-sprite-pack"
import { usePet } from "@/hooks/pet/use-pet"
import { resetPet } from "@/lib/db/pet"
import { toPetAssetDiagnostics } from "@/lib/pet/live2d/compatibility-diagnostics"
import { getPetSkinRuntime } from "@/lib/pet/skin-runtime"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_SETTINGS, type PetAssetDiagnostic, type PetSettings } from "@/types/pet"

import { PetRenderer } from "../pet-renderer"
import { resolveEffectiveSkinSelection } from "../skins/resolve-effective-skin"
import { PetAppearanceControls } from "./pet-appearance-controls"
import { PetCareControls } from "./pet-care-controls"
import { PetCosmeticControls } from "./pet-cosmetic-controls"
import { PetDesktopControls } from "./pet-desktop-controls"
import { PetInteractionControls } from "./pet-interaction-controls"
import { PetLive2dLookControls } from "./pet-live2d-look-controls"
import { PetSkinStatus } from "./pet-skin-status"
import { PetSoundControls } from "./pet-sound-controls"
import { PetTwinAwarenessControls } from "./pet-twin-awareness-controls"

/**
 * The single owner for every persisted pet-customization capability. Both the
 * console and Settings render this workspace so features cannot drift between
 * the two entry points.
 */
export function PetCustomizationWorkspace() {
  const t = useTranslations("settings.pet")
  const tc = useTranslations("pet.customize")
  const settings = useSettingsStore((state) => state.settings)
  const save = useSettingsStore((state) => state.save)
  const pet: PetSettings = settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const patch = (next: Partial<PetSettings>) => void save({ petSettings: { ...pet, ...next } })

  const { profile, view } = usePet()
  const { modelId, row: activeModel, coreReady } = useActiveLive2dModel(pet)
  const { row: activeSpritePack } = useActiveSpritePack(pet)
  const skinResolution = resolveEffectiveSkinSelection(
    pet.skinId,
    {
      coreReady,
      hasActiveModel: Boolean(modelId),
      modelReady: activeModel?.compatibility?.status !== "invalid",
      hasActiveSpritePack: Boolean(activeSpritePack),
    },
    { modelId, packId: activeSpritePack?.id }
  )
  const runtime = getPetSkinRuntime()
  useSyncExternalStore(runtime.subscribe, runtime.snapshotRevision, runtime.snapshotRevision)
  const assetKey =
    pet.skinId === "live2d" && modelId
      ? `live2d:${modelId}`
      : pet.skinId === "sprite-v2" && activeSpritePack?.id
        ? `sprite-v2:${activeSpritePack.id}`
        : undefined
  const diagnostics: PetAssetDiagnostic[] = [
    ...skinResolution.diagnostics,
    ...(activeModel?.compatibility
      ? toPetAssetDiagnostics(activeModel.compatibility.diagnostics)
      : []),
  ]
  const runtimeDiagnostic = assetKey ? runtime.assetDiagnostic(assetKey) : undefined
  if (runtimeDiagnostic) diagnostics.push(runtimeDiagnostic)
  const skinId = pet.skinId ?? "svg"

  return (
    <div
      data-testid="pet-customization-workspace"
      className="@container/pet-customization grid min-w-0 gap-6 @5xl/pet-customization:grid-cols-[minmax(0,1fr)_18rem]"
    >
      <SettingsStack className="min-w-0">
        <SettingsBlock
          icon={<PawPrintIcon />}
          title={t("enabled.label")}
          description={t("enabled.description")}
        >
          <FieldGroup>
            <Field orientation="responsive">
              <FieldContent>
                <FieldLabel htmlFor="pet-enabled">{t("enabled.label")}</FieldLabel>
                <FieldDescription>{t("enabled.description")}</FieldDescription>
              </FieldContent>
              <Switch
                id="pet-enabled"
                checked={pet.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
              />
            </Field>
          </FieldGroup>
        </SettingsBlock>

        <SettingsBlock
          icon={<BrushIcon />}
          title={tc("look.title")}
          description={
            skinId === "live2d"
              ? tc("look.descriptionLive2d")
              : skinId === "sprite-v2"
                ? tc("look.descriptionSprite")
                : tc("look.description")
          }
        >
          {skinId === "live2d" ? (
            <PetLive2dLookControls pet={pet} />
          ) : skinId === "sprite-v2" ? (
            <FieldDescription>{tc("look.spriteManagedBelow")}</FieldDescription>
          ) : (
            <PetCosmeticControls />
          )}
        </SettingsBlock>

        <SettingsBlock
          icon={<SettingsIcon />}
          title={tc("appearance.title")}
          description={tc("appearance.description")}
        >
          <PetAppearanceControls pet={pet} patch={patch} />
        </SettingsBlock>

        <SettingsBlock
          icon={<MessageCircleIcon />}
          title={tc("interaction.title")}
          description={tc("interaction.description")}
        >
          <PetInteractionControls pet={pet} patch={patch} />
        </SettingsBlock>

        <SettingsBlock
          icon={<Volume2Icon />}
          title={tc("sound.title")}
          description={tc("sound.description")}
        >
          <PetSoundControls pet={pet} patch={patch} />
        </SettingsBlock>

        <SettingsBlock
          icon={<HeartPulseIcon />}
          title={tc("care.title")}
          description={tc("care.description")}
        >
          <PetCareControls pet={pet} patch={patch} />
        </SettingsBlock>

        <SettingsBlock
          icon={<SparklesIcon />}
          title={t("twinAwareness.title")}
          description={t("twinAwareness.description")}
        >
          <PetTwinAwarenessControls pet={pet} patch={patch} />
        </SettingsBlock>

        <CapabilityGate profiles={["desktop"]}>
          <SettingsBlock
            icon={<MonitorIcon />}
            title={tc("desktop.title")}
            description={tc("desktop.description")}
          >
            <PetDesktopControls pet={pet} patch={patch} />
          </SettingsBlock>
        </CapabilityGate>

        <SettingsBlock
          icon={<RotateCcwIcon />}
          title={t("reset.label")}
          description={t("reset.description")}
          action={
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" size="sm" variant="destructive">
                  {t("reset.action")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("reset.confirmTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("reset.confirmDescription")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("reset.cancel")}</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => void resetPet()}>
                    {t("reset.confirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          }
        >
          <FieldDescription>{t("reset.profileScope")}</FieldDescription>
        </SettingsBlock>
      </SettingsStack>

      <aside className="order-first min-w-0 @5xl/pet-customization:order-last">
        <div className="flex min-h-56 flex-col gap-4 @5xl/pet-customization:sticky @5xl/pet-customization:top-0">
          <div className="flex flex-1 items-center justify-center rounded-xl bg-muted/30 p-5">
            {profile && view ? (
              <PetRenderer
                bones={view.effectiveBones}
                stage={profile.stage}
                state="idle"
                size={176}
                skinId={skinResolution.selection.skinId}
                selection={skinResolution.selection}
                renderPriority="configuration"
                lowPower={pet.lowPower}
                flavor={profile.evolutionFlavor}
              />
            ) : (
              <Empty className="border-0 p-4">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <PawPrintIcon />
                  </EmptyMedia>
                  <EmptyDescription>{tc("preview.unavailable")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
          <PetSkinStatus
            requestedSkinId={skinId}
            effectiveSkinId={skinResolution.selection.skinId}
            diagnostics={diagnostics}
            onRetry={runtimeDiagnostic && assetKey ? () => runtime.retryAsset(assetKey) : undefined}
          />
        </div>
      </aside>
    </div>
  )
}

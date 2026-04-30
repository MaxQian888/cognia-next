"use client"

/**
 * ArtifactsSection - User-facing controls for the artifact panel + auto-
 * detection. Mirrors the controls Cognia exposes in its artifacts feature
 * settings — full layout, no collapsing.
 */

import { useTranslations } from "next-intl"
import { Layers3Icon, RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useSettingsStore } from "@/stores/settings"
import { ARTIFACT_TYPES, ARTIFACT_I18N_TYPE_KEYS } from "@/lib/artifacts"
import { getArtifactTypeIcon } from "@/components/artifacts/artifact-icons"
import type { ArtifactType } from "@/types"

const DEFAULT_ENABLED_TYPES: ArtifactType[] = [...ARTIFACT_TYPES]

type ArtifactSettingsShape = {
  autoCreate: boolean
  minLines: number
  enabledTypes: ArtifactType[]
  showNotification: boolean
  defaultPanelMode: "code" | "preview"
  persistAcrossSessions: boolean
}

const DEFAULTS: ArtifactSettingsShape = {
  autoCreate: true,
  minLines: 10,
  enabledTypes: DEFAULT_ENABLED_TYPES,
  showNotification: true,
  defaultPanelMode: "code",
  persistAcrossSessions: true,
}

export function ArtifactsSection() {
  const t = useTranslations("settings.artifacts")
  const tArtifacts = useTranslations("artifacts")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const cfg = settings?.artifacts ?? {}
  const autoCreate = cfg.autoCreate ?? DEFAULTS.autoCreate
  const minLines = cfg.minLines ?? DEFAULTS.minLines
  const enabledTypes = cfg.enabledTypes ?? DEFAULTS.enabledTypes
  const showNotification = cfg.showNotification ?? DEFAULTS.showNotification
  const defaultPanelMode = cfg.defaultPanelMode ?? DEFAULTS.defaultPanelMode
  const persistAcrossSessions = cfg.persistAcrossSessions ?? DEFAULTS.persistAcrossSessions

  const update = (patch: Partial<ArtifactSettingsShape>) => {
    void save({
      artifacts: {
        autoCreate,
        minLines,
        enabledTypes,
        showNotification,
        defaultPanelMode,
        persistAcrossSessions,
        ...patch,
      },
    })
  }

  const toggleType = (type: ArtifactType, on: boolean) => {
    const next = on
      ? Array.from(new Set([...enabledTypes, type]))
      : enabledTypes.filter((t) => t !== type)
    update({ enabledTypes: next })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <Layers3Icon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-1">
          <Label className="text-sm">{t("autoCreateLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("autoCreateHint")}</p>
        </div>
        <Switch
          checked={autoCreate}
          onCheckedChange={(checked) => update({ autoCreate: checked })}
        />
      </div>

      <div className="space-y-2 border-t pt-4">
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t("minLinesLabel")}</Label>
          <span className="text-sm tabular-nums text-muted-foreground">{minLines}</span>
        </div>
        <Slider
          min={3}
          max={50}
          step={1}
          value={[minLines]}
          onValueChange={(v) => update({ minLines: v[0] ?? DEFAULTS.minLines })}
          className="w-full"
        />
        <p className="text-xs text-muted-foreground">{t("minLinesHint")}</p>
      </div>

      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm">{t("enabledTypesLabel")}</Label>
        <p className="text-xs text-muted-foreground">{t("enabledTypesHint")}</p>
        <div className="grid grid-cols-3 gap-2 pt-1">
          {ARTIFACT_TYPES.map((type) => {
            const isOn = enabledTypes.includes(type)
            return (
              <label
                key={type}
                className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm hover:bg-muted/50"
              >
                <Switch checked={isOn} onCheckedChange={(checked) => toggleType(type, checked)} />
                <span className="text-muted-foreground">{getArtifactTypeIcon(type)}</span>
                <span className="truncate">{tArtifacts(ARTIFACT_I18N_TYPE_KEYS[type])}</span>
              </label>
            )
          })}
        </div>
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-1">
          <Label className="text-sm">{t("showNotificationLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("showNotificationHint")}</p>
        </div>
        <Switch
          checked={showNotification}
          onCheckedChange={(checked) => update({ showNotification: checked })}
        />
      </div>

      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm">{t("defaultPanelModeLabel")}</Label>
        <RadioGroup
          value={defaultPanelMode}
          onValueChange={(v) => update({ defaultPanelMode: v as "code" | "preview" })}
          className="flex gap-4"
        >
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <RadioGroupItem value="code" id="artifacts-mode-code" />
            {t("defaultPanelMode.code")}
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <RadioGroupItem value="preview" id="artifacts-mode-preview" />
            {t("defaultPanelMode.preview")}
          </label>
        </RadioGroup>
        <p className="text-xs text-muted-foreground">{t("defaultPanelModeHint")}</p>
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-1">
          <Label className="text-sm">{t("persistAcrossSessionsLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("persistAcrossSessionsHint")}</p>
        </div>
        <Switch
          checked={persistAcrossSessions}
          onCheckedChange={(checked) => update({ persistAcrossSessions: checked })}
        />
      </div>

      <div className="border-t pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void save({ artifacts: { ...DEFAULTS } })}
        >
          <RotateCcwIcon className="mr-2 size-4" />
          {t("resetDefaults")}
        </Button>
      </div>
    </div>
  )
}

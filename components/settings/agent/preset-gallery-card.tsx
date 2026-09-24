"use client"

/**
 * PresetGalleryCard — the quick-start catalog of known agent presets.
 * Reached from the rail's "New agent" entry; picking a card opens the editor
 * dialog seeded with that preset.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { BrandIcon } from "@/components/icons/brand-icon"
import {
  getAvailablePresets,
  getPresetConfig,
  resolvePreferredCodexExecutablePresetId,
} from "@/lib/ai/agent/external/config/presets"

// =============================================================================
// Preset Gallery Card
// =============================================================================

export interface PresetGalleryCardProps {
  disabled: boolean
  onPick: (presetId: string) => void
}

const CODEX_EXECUTABLE_PRESET_IDS = ["codex", "codex-app-server"] as const

export function PresetGalleryCard({ disabled, onPick }: PresetGalleryCardProps) {
  const t = useTranslations("externalAgent.settings")
  const [showExperimental, setShowExperimental] = useState(false)
  // Auto-prefer the native app-server Codex preset when the `codex` CLI is on
  // PATH; otherwise the ACP shim. Surfaced as a "Recommended" hint — both stay
  // selectable. Defaults to the ACP preset until detection resolves.
  const [preferredCodexPreset, setPreferredCodexPreset] = useState<string>("codex")
  useEffect(() => {
    let active = true
    void resolvePreferredCodexExecutablePresetId().then((id) => {
      if (active) setPreferredCodexPreset(id)
    })
    return () => {
      active = false
    }
  }, [])

  const presets = getAvailablePresets()
    .map((id) => ({ id, config: getPresetConfig(id) }))
    .filter(
      (entry): entry is { id: string; config: NonNullable<ReturnType<typeof getPresetConfig>> } =>
        entry.config !== null
    )
    .filter(({ config }) => showExperimental || config.supportTier !== "documented-only")

  return (
    <Card data-testid="preset-gallery-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{t("quickStartTitle")}</CardTitle>
            <CardDescription>{t("quickStartDescription")}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="show-experimental-presets" className="text-xs">
              {t("showExperimental")}
            </Label>
            <Switch
              id="show-experimental-presets"
              checked={showExperimental}
              onCheckedChange={setShowExperimental}
              disabled={disabled}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {presets.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("presetGalleryEmpty")}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {presets.map(({ id, config }) => (
              <Card key={id} data-testid={`preset-card-${id}`} className="space-y-2 p-3">
                <div className="flex flex-wrap items-start justify-between gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <BrandIcon id={id} size={24} />
                    <p className="truncate text-sm font-medium">
                      {id === "opencode-v2-service" ? t("opencodeV2PresetName") : config.name}
                    </p>
                  </div>
                  {(CODEX_EXECUTABLE_PRESET_IDS as readonly string[]).includes(id) &&
                    id === preferredCodexPreset && (
                      <Badge
                        variant="default"
                        className="text-[10px]"
                        data-testid={`preset-recommended-${id}`}
                      >
                        {t("recommendedPreset")}
                      </Badge>
                    )}
                  {config.supportTier && (
                    <Badge
                      variant={
                        config.supportTier === "documented-only"
                          ? "destructive"
                          : config.supportTier === "guided"
                            ? "secondary"
                            : "outline"
                      }
                      className="text-[10px]"
                    >
                      {config.supportTier}
                    </Badge>
                  )}
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">
                  {id === "opencode-v2-service"
                    ? t("opencodeV2PresetDescription")
                    : id === "devin"
                      ? t("devinPresetDescription")
                      : config.description}
                </p>
                {/* `tags` is optional on the preset type and a plugin can register
                    a preset at runtime, so the gallery must not assume the array
                    exists — reading through it blanked the whole section. */}
                {(config.tags?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {config.tags!.slice(0, 3).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px]">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPick(id)}
                    disabled={disabled || config.supportTier === "documented-only"}
                    data-testid={`preset-pick-${id}`}
                  >
                    {t("useThisPreset")}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

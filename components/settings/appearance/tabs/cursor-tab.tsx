"use client"

// Pointer tab — the home for `settings.cursor`.
//
// Wiring summary:
//   - the pack / size / tint controls write `settings.cursor.{enabled,packId,
//     size,colorMode,customColor}`, consumed by `CursorApplier`, which owns the
//     `<style id="cognia-cursor">` block;
//   - the effect card writes `settings.cursor.effect`, consumed by
//     `CursorEffectLayer`, the canvas overlay mounted in the root layout.
//
// Both write through the same live-save pattern as the density/radius cards —
// no apply button, because a pointer you have to commit to is a pointer you
// can't evaluate.

import { useTranslations } from "next-intl"
import { CursorEffectCard } from "@/components/settings/appearance/components/cursor-effect-card"
import { CursorPackGrid } from "@/components/settings/appearance/components/cursor-pack-grid"
import { CursorRolePreview } from "@/components/settings/appearance/components/cursor-role-preview"
import { SettingSliderRow } from "@/components/settings/appearance/components/setting-slider-row"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { getCursorPack } from "@/lib/appearance/cursor/cursor-packs"
import { cursorPixelSize, resolveCursorPalette } from "@/lib/appearance/cursor/render-cursor"
import { useCursorAccentColor } from "@/lib/appearance/cursor/use-cursor-accent"
import { responsiveSelectClass } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"
import {
  CURSOR_SIZE_MAX,
  CURSOR_SIZE_MIN,
  DEFAULT_CURSOR,
  SYSTEM_CURSOR_PACK_ID,
  type CursorColorMode,
  type CursorEffectSettings,
  type CursorSettings,
} from "@/types/appearance"

const COLOR_MODES: readonly CursorColorMode[] = ["pack", "accent", "custom"]

export function CursorTab() {
  const t = useTranslations("settings.appearance.cursor")
  const stored = useSettingsStore((s) => s.settings?.cursor)
  const save = useSettingsStore((s) => s.save)
  const accentColor = useCursorAccentColor()

  const cursor: CursorSettings = { ...DEFAULT_CURSOR, ...(stored ?? {}) }
  const pack = getCursorPack(cursor.packId)
  const patch = (next: Partial<CursorSettings>) => void save({ cursor: { ...cursor, ...next } })

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="text-sm">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="cursor-enabled" className="text-xs">
            {t("enabledLabel")}
          </Label>
          <p className="text-[11px] text-muted-foreground">{t("enabledHint")}</p>
        </div>
        <Switch
          id="cursor-enabled"
          checked={cursor.enabled}
          onCheckedChange={(checked) => {
            // Turning the art on while still pointed at the system sentinel
            // would look broken — nothing would change. Move to the first
            // designed pack in the same write.
            const nextPackId =
              checked && cursor.packId === SYSTEM_CURSOR_PACK_ID ? "aero" : cursor.packId
            patch({ enabled: checked, packId: nextPackId })
          }}
        />
      </div>

      {cursor.enabled ? (
        <div className="space-y-6 border-t pt-4">
          <CursorPackGrid
            activePackId={cursor.packId}
            colorMode={cursor.colorMode}
            customColor={cursor.customColor}
            accentColor={accentColor}
            onSelect={(packId) => patch({ packId })}
          />

          <SettingSliderRow
            label={t("sizeLabel")}
            value={cursor.size}
            defaultValue={DEFAULT_CURSOR.size}
            min={CURSOR_SIZE_MIN}
            max={CURSOR_SIZE_MAX}
            step={0.25}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(size) => patch({ size })}
          />

          <div className="space-y-2">
            <Label className="text-xs">{t("colorLabel")}</Label>
            <Select
              value={cursor.colorMode}
              onValueChange={(value) => patch({ colorMode: value as CursorColorMode })}
            >
              <SelectTrigger className={responsiveSelectClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COLOR_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`colorModes.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t("colorHint")}</p>
          </div>

          {cursor.colorMode === "custom" ? (
            <div className="space-y-2">
              <Label htmlFor="cursor-custom-color" className="text-xs">
                {t("customColorLabel")}
              </Label>
              <Input
                id="cursor-custom-color"
                type="color"
                value={cursor.customColor ?? "#8b5cf6"}
                onChange={(e) => patch({ customColor: e.target.value })}
                className="h-9 w-20 p-1"
              />
            </div>
          ) : null}

          {pack ? (
            <div className="space-y-2">
              <Label className="text-xs">{t("rolesLabel")}</Label>
              <CursorRolePreview
                pack={pack}
                palette={resolveCursorPalette({
                  pack,
                  colorMode: cursor.colorMode,
                  customColor: cursor.customColor,
                  accentColor,
                })}
                sizePx={cursorPixelSize(cursor.size)}
              />
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">{t("systemSelectedHint")}</p>
          )}
        </div>
      ) : null}

      <div className="border-t pt-4">
        <CursorEffectCard
          effect={cursor.effect}
          onChange={(effect: CursorEffectSettings) => patch({ effect })}
        />
      </div>
    </div>
  )
}

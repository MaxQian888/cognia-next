"use client"

// Settings → Appearance → Style. The "shape" half of appearance (ADR-0148):
// pick a pack, then fine-tune. Sits first in the theme group because it is the
// entry decision — every other appearance control tunes what a pack sets.
//
// Colour lives one panel over and is fully orthogonal: any pack composes with
// any preset, built-in theme, or imported VSCode theme.

import { useTranslations } from "next-intl"
import { RotateCcwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_RADIUS, type RadiusSettings } from "@/types/appearance"
import { DEFAULT_STYLE_PACK, resolveStylePack } from "@/types/appearance/style-pack"
import { StylePackPicker } from "@/components/surface/style-pack-picker"
import { SettingSliderRow } from "../components/setting-slider-row"

export function StylePanel() {
  const t = useTranslations("settings.appearance.stylePack")
  const tLayout = useTranslations("settings.appearance.layoutType")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const stylePack = settings?.stylePack ?? DEFAULT_STYLE_PACK
  const resolved = resolveStylePack(stylePack)
  const hasOverrides = Object.keys(stylePack.overrides ?? {}).length > 0
  const radius: RadiusSettings = { ...DEFAULT_RADIUS, ...(settings?.radius ?? {}) }
  // The slider only speaks once it has been moved off the stylesheet default —
  // see `resolveRadiusVar`. Surface that plainly rather than letting the number
  // silently disagree with the pack.
  const radiusFollowsPack = Math.abs(radius.base - DEFAULT_RADIUS.base) < 1e-9

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="space-y-1">
          <Label className="text-sm">{t("sectionLabel")}</Label>
          <p className="text-[11px] text-muted-foreground">{t("sectionHint")}</p>
        </div>

        <StylePackPicker />

        {hasOverrides ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={() => void save({ stylePack: { packId: resolved.packId } })}
          >
            <RotateCcwIcon className="size-3.5" />
            {t("resetOverrides")}
          </Button>
        ) : null}
      </section>

      <section className="space-y-2 border-t pt-4">
        <Label className="text-sm">{tLayout("radius.sectionLabel")}</Label>
        <SettingSliderRow
          label={tLayout("radius.label")}
          ariaLabel={tLayout("radius.label")}
          value={radius.base}
          defaultValue={DEFAULT_RADIUS.base}
          min={0}
          max={1.5}
          step={0.025}
          format={(v) => `${v.toFixed(3)}rem`}
          onChange={(next) => void save({ radius: { base: next } })}
        />
        <p className="text-[11px] text-muted-foreground">
          {radiusFollowsPack ? t("radiusFollowsPack") : t("radiusOverridesPack")}
        </p>
      </section>
    </div>
  )
}

"use client"

// Settings → Appearance → Layout. Spacing, shape, and information-density
// controls that previously lived (mislabelled) under "Typography": global +
// per-surface density, corner radius, and the two progressive-disclosure
// display modes (agent flow, usage statistics). Motion controls live in the
// Accessibility tab, which is their single canonical home.

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_RADIUS, type RadiusSettings } from "@/types/appearance"
import { DensityCard } from "../components/density-card"
import { MessageDisplayCard } from "../components/message-display-card"
import { UsageDisplayCard } from "../components/usage-display-card"
import { SettingSliderRow } from "../components/setting-slider-row"

export function LayoutTab() {
  const tLayout = useTranslations("settings.appearance.layoutType")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const radius: RadiusSettings = { ...DEFAULT_RADIUS, ...(settings?.radius ?? {}) }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <Label className="text-sm">{tLayout("density.sectionLabel")}</Label>
        <DensityCard />
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
        <p className="text-[11px] text-muted-foreground">{tLayout("radius.hint")}</p>
      </section>

      <section className="space-y-2 border-t pt-4">
        <Label className="text-sm">{tLayout("messageDisplay.sectionLabel")}</Label>
        <MessageDisplayCard />
      </section>

      <section className="space-y-2 border-t pt-4">
        <Label className="text-sm">{tLayout("usageDisplay.sectionLabel")}</Label>
        <UsageDisplayCard />
      </section>
    </div>
  )
}

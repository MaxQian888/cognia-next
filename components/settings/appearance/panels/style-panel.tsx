"use client"

// Settings → Appearance → Style. The "shape" half of appearance (ADR-0148):
// pick a pack, then fine-tune. Sits first in the theme group because it is the
// entry decision — every other appearance control tunes what a pack sets.
//
// Colour lives one panel over and is fully orthogonal: any pack composes with
// any preset, built-in theme, or imported VSCode theme.

import { useTranslations } from "next-intl"
import { CheckIcon, RotateCcwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_RADIUS, type RadiusSettings } from "@/types/appearance"
import {
  DEFAULT_STYLE_PACK,
  STYLE_PACKS,
  STYLE_PACK_IDS,
  resolveStylePack,
  type StylePackId,
} from "@/types/appearance/style-pack"
import { cn } from "@/lib/utils"
import { SettingSliderRow } from "../components/setting-slider-row"

/**
 * Render each pack's geometry locally so the choice is legible before it is
 * made. The preview sets the same custom properties `StylePackApplier` writes
 * onto `<html>`, scoped to this element — which is also a cheap proof that the
 * pack really is expressible as those two variables.
 */
function PackPreview({ packId }: { packId: StylePackId }) {
  const pack = STYLE_PACKS[packId]
  return (
    <div
      aria-hidden
      className="pointer-events-none flex flex-col gap-1.5 rounded-panel border bg-muted/40 p-2"
      style={
        {
          "--radius": `${pack.radiusBaseRem}rem`,
          "--pill-radius": `${pack.pillRadiusPx}px`,
        } as React.CSSProperties
      }
    >
      <div
        className="flex items-center gap-1.5 rounded-panel border bg-background p-1.5"
        style={{ boxShadow: pack.elevationMax === 0 ? "none" : undefined }}
      >
        <span className="h-2 w-6 shrink-0 rounded-pill bg-primary/40" />
        <span className="h-1.5 flex-1 rounded-control bg-muted-foreground/20" />
      </div>
      <div className="flex gap-1.5">
        <span className="h-3 flex-1 rounded-control bg-primary/70" />
        <span className="h-3 w-6 rounded-control border" />
      </div>
    </div>
  )
}

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

        <div className="grid gap-2 sm:grid-cols-3">
          {STYLE_PACK_IDS.map((id) => {
            const active = resolved.packId === id
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                data-testid={`style-pack-${id}`}
                onClick={() => void save({ stylePack: { ...stylePack, packId: id } })}
                className={cn(
                  "group flex flex-col gap-2 rounded-panel border p-2.5 text-left transition-colors",
                  active
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-border hover:bg-accent/40"
                )}
              >
                <PackPreview packId={id} />
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-medium">{t(`packs.${id}.name`)}</span>
                  {active ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
                </div>
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {t(`packs.${id}.description`)}
                </span>
              </button>
            )
          })}
        </div>

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

"use client"

// Pointer-effect controls (Settings → Appearance → Pointer).
//
// The effect layer is independent of the pointer art — you can run sakura
// petals over the system cursor, or a themed pack with no effect at all — so
// this card owns its own enable state (`kind === "none"`) rather than hanging
// off the art's switch.
//
// The card also states, rather than hides, the two conditions that make the
// layer stand down (reduced motion, touch-only pointer). A decorative feature
// that silently does nothing is a support ticket.

import { useTranslations } from "next-intl"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
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
import { cn, responsiveSelectClass } from "@/lib/utils"
import {
  CURSOR_EFFECT_KINDS,
  DEFAULT_CURSOR_EFFECT,
  type CursorEffectColorMode,
  type CursorEffectKind,
  type CursorEffectSettings,
} from "@/types/appearance"

const COLOR_MODES: readonly CursorEffectColorMode[] = ["accent", "pack", "custom", "rainbow"]

export interface CursorEffectCardProps {
  effect: CursorEffectSettings
  onChange: (next: CursorEffectSettings) => void
}

export function CursorEffectCard({ effect, onChange }: CursorEffectCardProps) {
  const t = useTranslations("settings.appearance.cursor.effect")
  const { reduce } = useFlowMotion()
  const enabled = effect.kind !== "none"

  const patch = (next: Partial<CursorEffectSettings>) => onChange({ ...effect, ...next })

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-sm">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("kindLabel")}</Label>
        <div
          className="grid grid-cols-3 gap-2 @md/appearance-pane:grid-cols-4"
          data-testid="cursor-effect-kinds"
        >
          {CURSOR_EFFECT_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={effect.kind === kind}
              onClick={() => patch({ kind: kind as CursorEffectKind })}
              className={cn(
                "rounded-md border px-2 py-2 text-[11px] transition-colors",
                effect.kind === kind ? "border-primary bg-primary/5" : "hover:bg-accent/40"
              )}
            >
              {t(`kinds.${kind}`)}
            </button>
          ))}
        </div>
      </div>

      {reduce ? (
        <p
          className="rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground"
          data-testid="cursor-effect-reduced-motion"
        >
          {t("reducedMotionNotice")}
        </p>
      ) : null}

      {enabled ? (
        <div className="space-y-4 border-t pt-4">
          <SettingSliderRow
            label={t("intensityLabel")}
            value={effect.intensity}
            defaultValue={DEFAULT_CURSOR_EFFECT.intensity}
            min={0.1}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(value) => patch({ intensity: value })}
          />
          <SettingSliderRow
            label={t("scaleLabel")}
            value={effect.scale}
            defaultValue={DEFAULT_CURSOR_EFFECT.scale}
            min={0.5}
            max={2}
            step={0.1}
            format={(v) => `${v.toFixed(1)}×`}
            onChange={(value) => patch({ scale: value })}
          />

          <div className="space-y-2">
            <Label className="text-xs">{t("colorLabel")}</Label>
            <Select
              value={effect.colorMode}
              onValueChange={(value) => patch({ colorMode: value as CursorEffectColorMode })}
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
          </div>

          {effect.colorMode === "custom" ? (
            <div className="space-y-2">
              <Label htmlFor="cursor-effect-color" className="text-xs">
                {t("customColorLabel")}
              </Label>
              <Input
                id="cursor-effect-color"
                type="color"
                value={effect.customColor ?? "#8b5cf6"}
                onChange={(e) => patch({ customColor: e.target.value })}
                className="h-9 w-20 p-1"
              />
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="cursor-click-burst" className="text-xs">
                {t("clickBurstLabel")}
              </Label>
              <p className="text-[11px] text-muted-foreground">{t("clickBurstHint")}</p>
            </div>
            <Switch
              id="cursor-click-burst"
              checked={effect.clickBurst}
              onCheckedChange={(checked) => patch({ clickBurst: checked })}
            />
          </div>

          <p className="text-[11px] text-muted-foreground">{t("touchNotice")}</p>
        </div>
      ) : null}
    </div>
  )
}

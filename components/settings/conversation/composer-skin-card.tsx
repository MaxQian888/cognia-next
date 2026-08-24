"use client"

// Settings → Conversation: which composer skin to render, and the per-knob
// adjustments layered on it. Reads/writes `AppSettings.composerBehavior.skin`
// and `.skinOverrides` through the settings store `save`, live (same pattern as
// `appearance/components/density-card.tsx`).
//
// `classic` is presented as "the current look", not as one option among five
// equals — it is the default, it is what every existing user is already seeing,
// and it deliberately takes no adjustments.

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  COMPOSER_SKIN_IDS,
  DEFAULT_COMPOSER_SKIN,
  resolveComposerSkin,
  type ComposerSendShape,
  type ComposerSkinId,
  type ComposerSkinOverrides,
} from "@/lib/chat/composer-skin"
import type { AppSettings } from "@cognia/agent-config-types"

type ComposerBehavior = NonNullable<AppSettings["composerBehavior"]>

const SEND_SHAPES: ComposerSendShape[] = ["circle", "rounded"]

export function ComposerSkinCard() {
  const t = useTranslations("settings.conversation.composerSkin")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const cb: ComposerBehavior = settings?.composerBehavior ?? {}
  const skinId: ComposerSkinId = cb.skin ?? DEFAULT_COMPOSER_SKIN
  const overrides: ComposerSkinOverrides = cb.skinOverrides ?? {}
  const isClassic = skinId === "classic"
  // What the box will actually render, floors and clamps included — so the
  // preview cannot promise geometry the resolver would refuse.
  const resolved = resolveComposerSkin(cb, { isMobile: false })

  function update(patch: Partial<ComposerBehavior>): void {
    void save({ composerBehavior: { ...cb, ...patch } })
  }

  function setOverride(patch: Partial<ComposerSkinOverrides>): void {
    update({ skinOverrides: { ...overrides, ...patch } })
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="composer-skin" className="text-xs">
          {t("skinLabel")}
        </Label>
        <Select value={skinId} onValueChange={(value) => update({ skin: value as ComposerSkinId })}>
          <SelectTrigger id="composer-skin" className="w-full max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMPOSER_SKIN_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                {t(`skins.${id}.label`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t(`skins.${skinId}.hint`)}</p>
      </div>

      {/* Adjustments. `classic` takes none by design, so rather than hiding the
          group (which reads as "this skin has no settings") it stays visible,
          inert, and says why. */}
      <div className={cn("space-y-4 rounded border p-3", isClassic && "opacity-60")}>
        <div className="space-y-0.5">
          <Label className="text-xs">{t("adjustLabel")}</Label>
          <p className="text-[11px] text-muted-foreground">
            {isClassic ? t("adjustLockedHint") : t("adjustHint")}
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="composer-skin-radius" className="text-xs">
              {t("radiusLabel")}
            </Label>
            <span className="text-xs tabular-nums text-muted-foreground">
              {resolved.radiusPx}px
            </span>
          </div>
          <Slider
            id="composer-skin-radius"
            data-testid="skin-radius"
            aria-label={t("radiusLabel")}
            disabled={isClassic}
            min={0}
            max={32}
            step={1}
            value={[resolved.radiusPx]}
            onValueChange={([next]) => setOverride({ radiusPx: next })}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="composer-skin-pad" className="text-xs">
              {t("paddingLabel")}
            </Label>
            <span className="text-xs tabular-nums text-muted-foreground">{resolved.padXPx}px</span>
          </div>
          <Slider
            id="composer-skin-pad"
            data-testid="skin-padding"
            aria-label={t("paddingLabel")}
            disabled={isClassic}
            min={2}
            max={24}
            step={1}
            value={[resolved.padXPx]}
            onValueChange={([next]) => setOverride({ padXPx: next, padYPx: next })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="composer-skin-send" className="text-xs">
            {t("sendShapeLabel")}
          </Label>
          <Select
            value={resolved.sendShape}
            disabled={isClassic}
            onValueChange={(value) => setOverride({ sendShape: value as ComposerSendShape })}
          >
            <SelectTrigger id="composer-skin-send" className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEND_SHAPES.map((shape) => (
                <SelectItem key={shape} value={shape}>
                  {t(`sendShapes.${shape}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="composer-skin-mono" className="text-sm">
              {t("monoLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("monoHint")}</p>
          </div>
          <Switch
            id="composer-skin-mono"
            data-testid="skin-mono"
            aria-label={t("monoLabel")}
            disabled={isClassic}
            checked={resolved.mono}
            onCheckedChange={(next) => setOverride({ mono: next })}
          />
        </div>
      </div>

      {/* Reachability, stated where the user is choosing: a skin moves controls,
          it never removes them. Worth saying next to `focus`, whose row looks
          empty until you open the disclosure. */}
      <p className="text-[11px] text-muted-foreground">{t("reachabilityNote")}</p>

      {Object.keys(overrides).length > 0 && !isClassic ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => update({ skinOverrides: undefined })}
        >
          {t("resetOverrides", { skin: t(`skins.${skinId}.label`) })}
        </button>
      ) : null}

      <p className="sr-only" data-testid="composer-skin-resolved">
        {`${resolved.id}:${resolved.radiusPx}:${resolved.toolbarLayout}`}
      </p>
    </div>
  )
}

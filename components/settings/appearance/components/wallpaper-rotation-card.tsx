"use client"

// The carousel controls.
//
// Kept out of `wallpaper-tab.tsx`, which was already 729 lines and organised
// around a different question ("which wallpaper, and how does it sit?"). This
// card answers a third one: "and then what?".
//
// Two things here are worth knowing before editing:
//
//   - The transition select shows a LIVE degradation notice. `planTransition`
//     can downgrade what the user picked (reduced motion, or the legibility
//     scrim occupying the layer a crossfade needs), and a user who picks
//     "Ken Burns" and sees an instant cut deserves to be told why rather than
//     left wondering whether the setting saved.
//   - The playlist is either "everything" or an explicit set. An empty
//     playlist is not an empty selection, it is the default meaning "every
//     rotatable wallpaper", which is what keeps a freshly fetched daily
//     wallpaper in the rotation without re-curation.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, InfoIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { cn, responsiveSelectClass } from "@/lib/utils"
import { isRotatable, resolveRotationPool } from "@/lib/appearance/wallpaper-rotation"
import { planTransition } from "@/lib/appearance/wallpaper-transition"
import { prefersReducedMotion } from "@/lib/appearance/reduced-motion"
import {
  DEFAULT_WALLPAPER_ROTATION,
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
  WALLPAPER_INTERVAL_PRESETS,
  WALLPAPER_ROTATION_ORDERS,
  WALLPAPER_ROTATION_TRIGGERS,
  WALLPAPER_SLIDE_DIRECTIONS,
  WALLPAPER_TRANSITION_EASINGS,
  WALLPAPER_TRANSITIONS,
  type WallpaperRotationSettings,
} from "@/types/appearance/wallpaper-rotation"
import type { Wallpaper } from "@/types/appearance"

export interface WallpaperRotationCardProps {
  rotation: WallpaperRotationSettings
  /** Every wallpaper the gallery shows, built-ins and plugin ones included. */
  gallery: Wallpaper[]
  /** True when the legibility scrim is currently up, which limits transitions. */
  scrimActive: boolean
  onChange: (patch: Partial<WallpaperRotationSettings>) => void
}

export function WallpaperRotationCard({
  rotation,
  gallery,
  scrimActive,
  onChange,
}: WallpaperRotationCardProps) {
  const t = useTranslations("settings.appearance.wallpaper.rotation")

  const merged = { ...DEFAULT_WALLPAPER_ROTATION, ...rotation }
  const rotatable = useMemo(() => gallery.filter(isRotatable), [gallery])
  const pool = useMemo(
    () => resolveRotationPool(merged.playlist, gallery),
    [merged.playlist, gallery]
  )

  // Recomputed on every render rather than memoised: the OS hint can change
  // under a running app, and this is a handful of comparisons.
  const plan = planTransition({
    rotation: merged,
    scrimActive,
    reducedMotion: prefersReducedMotion(),
  })

  const usingEverything = merged.playlist.length === 0
  const intervalIsPreset = WALLPAPER_INTERVAL_PRESETS.includes(merged.intervalMs)

  const togglePlaylistMember = (id: string) => {
    // Turning the first tile off has to convert "everything" into an explicit
    // list first, otherwise the click would read as a no-op.
    const base = usingEverything ? rotatable.map((w) => w.id) : merged.playlist
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
    onChange({ playlist: next })
  }

  return (
    <section
      className="space-y-3 rounded-lg border p-3"
      data-testid="wallpaper-rotation"
      data-enabled={merged.enabled}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("title")}</Label>
          <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
        </div>
        <Switch
          checked={merged.enabled}
          onCheckedChange={(checked) => onChange({ enabled: checked })}
          aria-label={t("enableAria")}
          data-testid="wallpaper-rotation-enable"
        />
      </div>

      {merged.enabled && rotatable.length < 2 && (
        <p className="text-[11px] text-amber-600 dark:text-amber-500" role="status">
          {t("needsTwo")}
        </p>
      )}

      <fieldset
        disabled={!merged.enabled}
        className={cn("space-y-3", !merged.enabled && "pointer-events-none opacity-50")}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-[11px]">{t("triggerLabel")}</Label>
            <Select
              value={merged.trigger}
              onValueChange={(value) =>
                onChange({ trigger: value as WallpaperRotationSettings["trigger"] })
              }
            >
              <SelectTrigger className={responsiveSelectClass} data-testid="rotation-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WALLPAPER_ROTATION_TRIGGERS.map((trigger) => (
                  <SelectItem key={trigger} value={trigger}>
                    {t(`trigger.${trigger}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {merged.trigger === "interval" && (
            <div className="space-y-1.5">
              <Label className="text-[11px]">{t("intervalLabel")}</Label>
              <Select
                value={String(merged.intervalMs)}
                onValueChange={(value) => onChange({ intervalMs: Number(value) })}
              >
                <SelectTrigger className={responsiveSelectClass} data-testid="rotation-interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WALLPAPER_INTERVAL_PRESETS.map((ms) => (
                    <SelectItem key={ms} value={String(ms)}>
                      {t("intervalOption", { minutes: Math.round(ms / 60_000) })}
                    </SelectItem>
                  ))}
                  {/* A stored value outside the preset list would otherwise
                      render an EMPTY trigger. Reading it back is honest and
                      lets the user keep it or replace it. */}
                  {!intervalIsPreset && (
                    <SelectItem value={String(merged.intervalMs)}>
                      {t("intervalOption", { minutes: Math.round(merged.intervalMs / 60_000) })}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-[11px]">{t("orderLabel")}</Label>
            <Select
              value={merged.order}
              onValueChange={(value) =>
                onChange({ order: value as WallpaperRotationSettings["order"] })
              }
            >
              <SelectTrigger className={responsiveSelectClass} data-testid="rotation-order">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WALLPAPER_ROTATION_ORDERS.map((order) => (
                  <SelectItem key={order} value={order}>
                    {t(`order.${order}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px]">{t("transitionLabel")}</Label>
            <Select
              value={merged.transition}
              onValueChange={(value) =>
                onChange({ transition: value as WallpaperRotationSettings["transition"] })
              }
            >
              <SelectTrigger className={responsiveSelectClass} data-testid="rotation-transition">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WALLPAPER_TRANSITIONS.map((transition) => (
                  <SelectItem key={transition} value={transition}>
                    {t(`transition.${transition}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {merged.transition === "slide" && (
            <div className="space-y-1.5">
              <Label className="text-[11px]">{t("directionLabel")}</Label>
              <Select
                value={merged.slideDirection}
                onValueChange={(value) =>
                  onChange({
                    slideDirection: value as WallpaperRotationSettings["slideDirection"],
                  })
                }
              >
                <SelectTrigger className={responsiveSelectClass} data-testid="rotation-direction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WALLPAPER_SLIDE_DIRECTIONS.map((direction) => (
                    <SelectItem key={direction} value={direction}>
                      {t(`direction.${direction}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {merged.transition !== "none" && (
            <div className="space-y-1.5">
              <Label className="text-[11px]">{t("easingLabel")}</Label>
              <Select
                value={merged.easing}
                onValueChange={(value) =>
                  onChange({ easing: value as WallpaperRotationSettings["easing"] })
                }
              >
                <SelectTrigger className={responsiveSelectClass} data-testid="rotation-easing">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WALLPAPER_TRANSITION_EASINGS.map((easing) => (
                    <SelectItem key={easing} value={easing}>
                      {t(`easing.${easing}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {merged.transition !== "none" && (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label className="text-[11px]">{t("durationLabel")}</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t("durationValue", { ms: merged.transitionMs })}
              </span>
            </div>
            <Slider
              value={[merged.transitionMs]}
              min={MIN_TRANSITION_MS}
              max={MAX_TRANSITION_MS}
              step={50}
              disabled={!merged.enabled}
              onValueChange={([value]) => onChange({ transitionMs: value })}
              aria-label={t("durationLabel")}
              data-testid="rotation-duration"
            />
          </div>
        )}

        {plan.degradedBy && (
          <p
            className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
            role="status"
            data-testid="rotation-degraded"
          >
            <InfoIcon className="mt-0.5 size-3 shrink-0" />
            <span>{t(`degraded.${plan.degradedBy}`)}</span>
          </p>
        )}

        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <Label className="text-[11px]">{t("playlistLabel")}</Label>
            {!usingEverything && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 text-[11px]"
                onClick={() => onChange({ playlist: [] })}
                data-testid="rotation-playlist-reset"
              >
                {t("playlistUseAll")}
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {usingEverything
              ? t("playlistAllHint", { count: pool.length })
              : t("playlistSomeHint", { count: pool.length })}
          </p>
          <div className="flex flex-wrap gap-1.5" data-testid="rotation-playlist">
            {rotatable.map((wallpaper) => {
              const selected = usingEverything || merged.playlist.includes(wallpaper.id)
              return (
                <Badge
                  key={wallpaper.id}
                  asChild
                  variant={selected ? "default" : "outline"}
                  className="cursor-pointer select-none"
                >
                  <button
                    type="button"
                    onClick={() => togglePlaylistMember(wallpaper.id)}
                    aria-pressed={selected}
                    data-testid={`rotation-playlist-${wallpaper.id}`}
                  >
                    {selected && <CheckIcon className="size-3" />}
                    <span className="max-w-32 truncate">{wallpaper.name}</span>
                  </button>
                </Badge>
              )
            })}
          </div>
        </div>

        <div className="space-y-2 border-t pt-3">
          <ToggleRow
            label={t("pauseHiddenLabel")}
            hint={t("pauseHiddenHint")}
            checked={merged.pauseWhenHidden}
            onChange={(checked) => onChange({ pauseWhenHidden: checked })}
            testId="rotation-pause-hidden"
          />
          <ToggleRow
            label={t("reducedMotionLabel")}
            hint={t("reducedMotionHint")}
            checked={merged.respectReducedMotion}
            onChange={(checked) => onChange({ respectReducedMotion: checked })}
            testId="rotation-reduced-motion"
          />
        </div>
      </fieldset>
    </section>
  )
}

interface ToggleRowProps {
  label: string
  hint: string
  checked: boolean
  onChange: (next: boolean) => void
  testId: string
}

function ToggleRow({ label, hint, checked, onChange, testId }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <Label className="text-[11px]">{label}</Label>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
        data-testid={testId}
      />
    </div>
  )
}

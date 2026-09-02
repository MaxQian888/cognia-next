"use client"

// Lock-screen appearance.
//
// One rule shapes every control here: nothing may make the screen harder to
// unlock. That is why the dim slider exists at all (a bright photograph behind
// a password field is the failure case), why it has a floor warning rather
// than being free to zero, and why the preview shows the card on top of the
// backdrop rather than the backdrop alone.
//
// The widgets question is deliberately not asked. A lock screen exists because
// what is behind it is not for whoever is standing there, so a clock and a
// greeting are the whole surface: neither says anything about the account.

import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { LockKeyholeIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
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
import { isRotatable } from "@/lib/appearance/wallpaper-rotation"
import {
  clampLockDim,
  DEFAULT_LOCK_SCREEN,
  LOCK_SCREEN_BACKDROPS,
  LOCK_SCREEN_CLOCKS,
  LOCK_SCREEN_GREETINGS,
  LOCK_SCREEN_HOUR_CYCLES,
  LOCK_SCREEN_MOTIONS,
  MAX_GREETING_LENGTH,
  MAX_LOCK_BLUR_PX,
  MIN_LOCK_BLUR_PX,
  normalizeGreeting,
  type LockScreenSettings,
} from "@/types/appearance/lock-screen"
import type { Wallpaper } from "@/types/appearance"

/**
 * Below this, a photographic backdrop starts to compete with the card. The
 * setting is still allowed lower, because a dark wallpaper is fine at zero,
 * but the user is told which way the tradeoff runs.
 */
export const LOW_DIM_THRESHOLD = 0.25

export interface LockScreenCardProps {
  settings: LockScreenSettings
  gallery: Wallpaper[]
  onChange: (patch: Partial<LockScreenSettings>) => void
}

export function LockScreenCard({ settings, gallery, onChange }: LockScreenCardProps) {
  const t = useTranslations("settings.appearance.lockScreen")

  const merged = { ...DEFAULT_LOCK_SCREEN, ...settings }
  const pinnable = useMemo(() => gallery.filter(isRotatable), [gallery])

  const usesImage = merged.backdrop === "wallpaper" || merged.backdrop === "pinned"
  const dimIsLow = usesImage && clampLockDim(merged.dim) < LOW_DIM_THRESHOLD

  return (
    <section className="space-y-3 rounded-lg border p-3" data-testid="lock-screen-card">
      <div className="flex items-start gap-2">
        <LockKeyholeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="space-y-0.5">
          <Label className="text-sm">{t("title")}</Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[11px]">{t("backdropLabel")}</Label>
          <Select
            value={merged.backdrop}
            onValueChange={(value) =>
              onChange({ backdrop: value as LockScreenSettings["backdrop"] })
            }
          >
            <SelectTrigger className={responsiveSelectClass} data-testid="lock-backdrop">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCK_SCREEN_BACKDROPS.map((backdrop) => (
                <SelectItem key={backdrop} value={backdrop}>
                  {t(`backdrop.${backdrop}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {merged.backdrop === "pinned" && (
          <div className="space-y-1.5">
            <Label className="text-[11px]">{t("pinnedLabel")}</Label>
            <Select
              value={merged.pinnedWallpaperId ?? ""}
              onValueChange={(value) => onChange({ pinnedWallpaperId: value || null })}
            >
              <SelectTrigger className={responsiveSelectClass} data-testid="lock-pinned">
                <SelectValue placeholder={t("pinnedPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {pinnable.map((wallpaper) => (
                  <SelectItem key={wallpaper.id} value={wallpaper.id}>
                    {wallpaper.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {pinnable.length === 0 && (
              <p className="text-[11px] text-muted-foreground">{t("pinnedEmpty")}</p>
            )}
          </div>
        )}

        {merged.backdrop === "solid" && (
          <div className="space-y-1.5">
            <Label className="text-[11px]">{t("solidLabel")}</Label>
            <Input
              type="color"
              value={merged.solidColor}
              onChange={(event) => onChange({ solidColor: event.target.value })}
              className="h-9 w-full p-1"
              data-testid="lock-solid-color"
            />
          </div>
        )}
      </div>

      {usesImage && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="lock-image-controls">
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label className="text-[11px]">{t("blurLabel")}</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {merged.blurPx}px
              </span>
            </div>
            <Slider
              value={[merged.blurPx]}
              min={MIN_LOCK_BLUR_PX}
              max={MAX_LOCK_BLUR_PX}
              step={1}
              onValueChange={([value]) => onChange({ blurPx: value })}
              aria-label={t("blurLabel")}
              data-testid="lock-blur"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label className="text-[11px]">{t("dimLabel")}</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {Math.round(clampLockDim(merged.dim) * 100)}%
              </span>
            </div>
            <Slider
              value={[Math.round(clampLockDim(merged.dim) * 100)]}
              min={0}
              max={100}
              step={5}
              onValueChange={([value]) => onChange({ dim: value / 100 })}
              aria-label={t("dimLabel")}
              data-testid="lock-dim"
            />
            <p
              className={cn(
                "text-[11px]",
                dimIsLow ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"
              )}
              data-testid="lock-dim-hint"
              role={dimIsLow ? "status" : undefined}
            >
              {t(dimIsLow ? "dimTooLow" : "dimHint")}
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[11px]">{t("clockLabel")}</Label>
          <Select
            value={merged.clock}
            onValueChange={(value) => onChange({ clock: value as LockScreenSettings["clock"] })}
          >
            <SelectTrigger className={responsiveSelectClass} data-testid="lock-clock">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCK_SCREEN_CLOCKS.map((clock) => (
                <SelectItem key={clock} value={clock}>
                  {t(`clock.${clock}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {merged.clock !== "none" && (
          <div className="space-y-1.5">
            <Label className="text-[11px]">{t("hourCycleLabel")}</Label>
            <Select
              value={merged.hourCycle}
              onValueChange={(value) =>
                onChange({ hourCycle: value as LockScreenSettings["hourCycle"] })
              }
            >
              <SelectTrigger className={responsiveSelectClass} data-testid="lock-hour-cycle">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCK_SCREEN_HOUR_CYCLES.map((cycle) => (
                  <SelectItem key={cycle} value={cycle}>
                    {t(`hourCycle.${cycle}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1.5">
          <Label className="text-[11px]">{t("greetingLabel")}</Label>
          <Select
            value={merged.greeting}
            onValueChange={(value) =>
              onChange({ greeting: value as LockScreenSettings["greeting"] })
            }
          >
            <SelectTrigger className={responsiveSelectClass} data-testid="lock-greeting">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCK_SCREEN_GREETINGS.map((greeting) => (
                <SelectItem key={greeting} value={greeting}>
                  {t(`greeting.${greeting}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {merged.greeting === "custom" && (
          <div className="space-y-1.5">
            <Label className="text-[11px]">{t("customGreetingLabel")}</Label>
            <Input
              value={merged.customGreeting}
              maxLength={MAX_GREETING_LENGTH}
              onChange={(event) =>
                onChange({ customGreeting: normalizeGreeting(event.target.value) })
              }
              data-testid="lock-custom-greeting"
            />
          </div>
        )}

        <div className="space-y-1.5">
          <Label className="text-[11px]">{t("motionLabel")}</Label>
          <Select
            value={merged.motion}
            onValueChange={(value) => onChange({ motion: value as LockScreenSettings["motion"] })}
          >
            <SelectTrigger className={responsiveSelectClass} data-testid="lock-motion">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCK_SCREEN_MOTIONS.map((motion) => (
                <SelectItem key={motion} value={motion}>
                  {t(`motion.${motion}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2 border-t pt-3">
        {merged.motion !== "none" && (
          <ToggleRow
            label={t("respectMotionLabel")}
            hint={t("respectMotionHint")}
            checked={merged.respectSystemMotion}
            onChange={(checked) => onChange({ respectSystemMotion: checked })}
            testId="lock-respect-motion"
          />
        )}
        <ToggleRow
          label={t("avatarLabel")}
          hint={t("avatarHint")}
          checked={merged.showAvatar}
          onChange={(checked) => onChange({ showAvatar: checked })}
          testId="lock-show-avatar"
        />
      </div>
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

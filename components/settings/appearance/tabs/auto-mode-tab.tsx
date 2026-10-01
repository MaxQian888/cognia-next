"use client"

// Settings → Appearance → Auto. Configures the automatic light/dark switcher
// driven by `lib/appearance/use-auto-mode.ts`. Four triggers:
//   - system    → follow the OS preference,
//   - schedule  → switch at local HH:mm thresholds,
//   - sunset    → switch at sunrise / sunset for a captured location,
//   - wallpaper → whichever variant lets more of the active wallpaper show.
// Persists through the generic `save({ autoMode })` setter; the runner reads
// the same store slice live, so edits take effect within a minute.
//
// The time and coordinate fields save once, on blur or Enter. `autoMode` is
// host-writable and `/me/appearance` embeds this tab on a paired phone, so a
// save per change queued a host update for every half-typed time and
// coordinate — and a lone "-" on the way to "-33.9" saved latitude 0. A field
// left empty, half-entered or out of range reverts instead of saving.

import { useTranslations } from "next-intl"
import { MapPinIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { responsiveSelectClass } from "@/lib/utils"
import { useSettingDraft } from "@/hooks/settings/use-setting-draft"
import { parseHmToMinutes } from "@/lib/appearance/auto-mode"
import { findActiveWallpaper } from "@/lib/appearance/presets"
import { useWallpaperThemeFit } from "@/hooks/appearance/use-wallpaper-theme-fit"
import { useSettingsStore } from "@/stores/settings"
import type { AutoModeSettings, AutoModeTrigger } from "@/types/appearance"

const TRIGGERS: AutoModeTrigger[] = ["system", "schedule", "sunset", "wallpaper"]

/** A complete "HH:MM", else `null`: a cleared or half-entered time field. */
const validTimeOfDay = (value: string): string | null =>
  parseHmToMinutes(value) === null ? null : value

/** A finite coordinate within ±`limit` degrees, canonicalised; else `null`. */
const validCoordinate = (limit: number) => (raw: string) => {
  const trimmed = raw.trim()
  if (trimmed === "") return null
  const n = Number(trimmed)
  return Number.isFinite(n) && Math.abs(n) <= limit ? String(n) : null
}
const validLatitude = validCoordinate(90)
const validLongitude = validCoordinate(180)

export function AutoModeTab() {
  const t = useTranslations("settings.appearance.auto")
  const autoMode = useSettingsStore((s) => s.autoMode)
  const save = useSettingsStore((s) => s.save)
  const background = useSettingsStore((s) => s.background)
  const wallpapers = useSettingsStore((s) => s.wallpapers)
  const activeWallpaper = findActiveWallpaper(background, wallpapers)
  const wallpaperFit = useWallpaperThemeFit(activeWallpaper, background.blurPx)

  const write = (p: Partial<AutoModeSettings>) => save({ autoMode: { ...autoMode, ...p } })
  const patch = (p: Partial<AutoModeSettings>) => void write(p)

  const schedule = autoMode.schedule ?? { lightAt: "07:00", darkAt: "19:00" }
  const location = autoMode.location

  const lightAt = useSettingDraft(
    schedule.lightAt,
    (next) => write({ schedule: { ...schedule, lightAt: next } }),
    { normalize: validTimeOfDay }
  )
  const darkAt = useSettingDraft(
    schedule.darkAt,
    (next) => write({ schedule: { ...schedule, darkAt: next } }),
    { normalize: validTimeOfDay }
  )
  const latitude = useSettingDraft(
    location ? String(location.latitude) : "",
    (next) =>
      write({
        location: {
          latitude: Number(next),
          longitude: location?.longitude ?? 0,
          source: "manual",
        },
      }),
    { normalize: validLatitude }
  )
  const longitude = useSettingDraft(
    location ? String(location.longitude) : "",
    (next) =>
      write({
        location: {
          latitude: location?.latitude ?? 0,
          longitude: Number(next),
          source: "manual",
        },
      }),
    { normalize: validLongitude }
  )
  const geoAvailable = typeof navigator !== "undefined" && !!navigator.geolocation

  const captureLocation = () => {
    if (!geoAvailable) return
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        patch({
          location: {
            latitude: Math.round(pos.coords.latitude * 1e4) / 1e4,
            longitude: Math.round(pos.coords.longitude * 1e4) / 1e4,
            source: "os",
          },
        }),
      () => {
        /* permission denied / unavailable — leave the prior location intact */
      }
    )
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">{t("description")}</p>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <Label className="text-sm">{t("enabledLabel")}</Label>
          <p className="text-[11px] text-muted-foreground">{t("enabledHint")}</p>
        </div>
        <Switch
          checked={autoMode.enabled}
          onCheckedChange={(checked) => patch({ enabled: checked })}
          aria-label={t("enabledLabel")}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t("trigger.label")}</Label>
        <Select
          value={autoMode.trigger}
          onValueChange={(value) => patch({ trigger: value as AutoModeTrigger })}
        >
          <SelectTrigger className={responsiveSelectClass} aria-label={t("trigger.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRIGGERS.map((trigger) => (
              <SelectItem key={trigger} value={trigger}>
                {t(`trigger.${trigger}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("trigger.hint")}</p>
      </div>

      {autoMode.trigger === "schedule" && (
        <div className="grid grid-cols-1 gap-4 @md/appearance-pane:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="auto-light-at" className="text-xs">
              {t("schedule.lightAt")}
            </Label>
            <Input
              id="auto-light-at"
              type="time"
              value={lightAt.value}
              onChange={(e) => lightAt.set(e.target.value)}
              onBlur={lightAt.commit}
              onKeyDown={lightAt.commitOnEnter}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auto-dark-at" className="text-xs">
              {t("schedule.darkAt")}
            </Label>
            <Input
              id="auto-dark-at"
              type="time"
              value={darkAt.value}
              onChange={(e) => darkAt.set(e.target.value)}
              onBlur={darkAt.commit}
              onKeyDown={darkAt.commitOnEnter}
            />
          </div>
        </div>
      )}

      {autoMode.trigger === "sunset" && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" onClick={captureLocation} disabled={!geoAvailable}>
              <MapPinIcon className="size-3.5" />
              {t("sunset.useLocation")}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {location
                ? t("sunset.currentLocation", { lat: location.latitude, lng: location.longitude })
                : t("sunset.noLocation")}
            </span>
          </div>
          {!geoAvailable && (
            <p className="text-[11px] text-muted-foreground">{t("sunset.unavailable")}</p>
          )}
          <div className="grid grid-cols-1 gap-4 @md/appearance-pane:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="auto-lat" className="text-xs">
                {t("sunset.latitude")}
              </Label>
              <Input
                id="auto-lat"
                type="number"
                inputMode="decimal"
                value={latitude.value}
                onChange={(e) => latitude.set(e.target.value)}
                onBlur={latitude.commit}
                onKeyDown={latitude.commitOnEnter}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="auto-lng" className="text-xs">
                {t("sunset.longitude")}
              </Label>
              <Input
                id="auto-lng"
                type="number"
                inputMode="decimal"
                value={longitude.value}
                onChange={(e) => longitude.set(e.target.value)}
                onBlur={longitude.commit}
                onKeyDown={longitude.commitOnEnter}
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("sunset.hint")}</p>
        </div>
      )}

      {autoMode.trigger === "wallpaper" && (
        <p className="text-[11px] text-muted-foreground" data-testid="auto-wallpaper-status">
          {!activeWallpaper
            ? t("wallpaper.noWallpaper")
            : !wallpaperFit.fit
              ? t("wallpaper.measuring")
              : wallpaperFit.fit.recommended === "dark"
                ? t("wallpaper.suitsDark")
                : t("wallpaper.suitsLight")}
        </p>
      )}

      <p className="text-[11px] text-muted-foreground">{t("snoozeNote")}</p>
    </div>
  )
}

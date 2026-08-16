"use client"

// Settings → Appearance → Auto. Configures the automatic light/dark switcher
// driven by `lib/appearance/use-auto-mode.ts`. Three triggers:
//   - system   → follow the OS preference,
//   - schedule → switch at local HH:mm thresholds,
//   - sunset   → switch at sunrise / sunset for a captured location.
// Persists through the generic `save({ autoMode })` setter; the runner reads
// the same store slice live, so edits take effect within a minute.

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
import { useSettingsStore } from "@/stores/settings"
import type { AutoModeSettings, AutoModeTrigger } from "@/types/appearance"

const TRIGGERS: AutoModeTrigger[] = ["system", "schedule", "sunset"]

export function AutoModeTab() {
  const t = useTranslations("settings.appearance.auto")
  const autoMode = useSettingsStore((s) => s.autoMode)
  const save = useSettingsStore((s) => s.save)

  const patch = (p: Partial<AutoModeSettings>) => void save({ autoMode: { ...autoMode, ...p } })

  const schedule = autoMode.schedule ?? { lightAt: "07:00", darkAt: "19:00" }
  const location = autoMode.location
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
              value={schedule.lightAt}
              onChange={(e) => patch({ schedule: { ...schedule, lightAt: e.target.value } })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auto-dark-at" className="text-xs">
              {t("schedule.darkAt")}
            </Label>
            <Input
              id="auto-dark-at"
              type="time"
              value={schedule.darkAt}
              onChange={(e) => patch({ schedule: { ...schedule, darkAt: e.target.value } })}
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
                value={location?.latitude ?? ""}
                onChange={(e) =>
                  patch({
                    location: {
                      latitude: Number(e.target.value),
                      longitude: location?.longitude ?? 0,
                      source: "manual",
                    },
                  })
                }
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
                value={location?.longitude ?? ""}
                onChange={(e) =>
                  patch({
                    location: {
                      latitude: location?.latitude ?? 0,
                      longitude: Number(e.target.value),
                      source: "manual",
                    },
                  })
                }
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("sunset.hint")}</p>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">{t("snoozeNote")}</p>
    </div>
  )
}

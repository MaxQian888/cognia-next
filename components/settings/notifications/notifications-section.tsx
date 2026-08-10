"use client"

// Notification Center preferences (ADR-0042). Edits the AppSettings
// `notificationPreferences` JSON: OS permission, channel defaults, per-level OS/
// push gates, DND/quiet-hours, per-source mute (the exception model), sound/
// badge, focus-awareness, snooze auto-wake, and retention. Reads/writes through
// the settings store; the routing core consumes these live.

import { useTranslations } from "next-intl"
import { BellIcon, RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "@/stores/settings"
import { useNotificationPermission } from "@/hooks/notifications/use-notification-permission"
import { resolvePreferences } from "@/lib/notifications/preferences"
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_SOURCES,
  type NotificationChannel,
  type NotificationLevel,
  type NotificationPreferences,
  type NotificationSource,
} from "@/types/notifications"

const DAY_MS = 24 * 60 * 60 * 1000
const GATED_LEVELS: NotificationLevel[] = ["info", "success", "warning", "error", "critical"]

function LevelSelect({
  value,
  onChange,
  id,
  label,
}: {
  value: NotificationLevel
  onChange: (v: NotificationLevel) => void
  id: string
  label: (lv: NotificationLevel) => string
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as NotificationLevel)}>
      <SelectTrigger id={id} className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {GATED_LEVELS.map((lv) => (
          <SelectItem key={lv} value={lv}>
            {label(lv)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function NotificationsSection() {
  const t = useTranslations("settings.notifications")
  const tLevels = useTranslations("notificationCenter.levels")
  const tSources = useTranslations("notificationCenter.sources")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const { state: permState, requesting, request } = useNotificationPermission()

  const prefs = resolvePreferences(settings?.notificationPreferences)

  const update = (patch: Partial<NotificationPreferences>) => {
    void save({ notificationPreferences: { ...prefs, ...patch } })
  }

  const hasChannel = (c: NotificationChannel) => prefs.globalDefaultChannels.includes(c)
  const toggleChannel = (c: NotificationChannel, on: boolean) => {
    const next = new Set(prefs.globalDefaultChannels)
    if (on) next.add(c)
    else next.delete(c)
    next.add("center") // center is always on
    update({ globalDefaultChannels: [...next] })
  }

  const sourceEnabled = (s: NotificationSource) => prefs.perSource[s]?.enabled !== false
  const toggleSource = (s: NotificationSource, on: boolean) => {
    update({ perSource: { ...prefs.perSource, [s]: { ...prefs.perSource[s], enabled: on } } })
  }

  return (
    <div className="space-y-6" data-testid="notifications-settings">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <BellIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {/* OS permission */}
      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="space-y-1">
          <Label className="text-sm">{t("osPermissionLabel")}</Label>
          <p className="text-xs text-muted-foreground">
            {permState === "granted"
              ? t("osPermissionGranted")
              : permState === "denied"
                ? t("osPermissionDenied")
                : t("osPermissionHint")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={requesting || permState === "granted"}
          onClick={() => void request()}
        >
          {permState === "granted" ? t("osPermissionEnabled") : t("osPermissionEnable")}
        </Button>
      </div>

      {/* Default channels */}
      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm">{t("channelsLabel")}</Label>
        <p className="text-xs text-muted-foreground">{t("channelsHint")}</p>
        <div className="flex flex-col gap-2 pt-1">
          {(["toast", "os", "push"] as NotificationChannel[]).map((c) => (
            <div key={c} className="flex items-center justify-between">
              <span className="text-sm">{t(`channel.${c}`)}</span>
              <Switch checked={hasChannel(c)} onCheckedChange={(on) => toggleChannel(c, on)} />
            </div>
          ))}
        </div>
      </div>

      {/* Level gates */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="min-os" className="text-sm">
            {t("minOsLevelLabel")}
          </Label>
          <LevelSelect
            id="min-os"
            value={prefs.minOsLevel}
            label={tLevels}
            onChange={(v) => update({ minOsLevel: v })}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="min-push" className="text-sm">
            {t("minPushLevelLabel")}
          </Label>
          <LevelSelect
            id="min-push"
            value={prefs.minPushLevel}
            label={tLevels}
            onChange={(v) => update({ minPushLevel: v })}
          />
        </div>
      </div>

      {/* Quiet hours / DND */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label className="text-sm">{t("dndLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("dndHint")}</p>
          </div>
          <Switch
            checked={prefs.quietHours.enabled}
            onCheckedChange={(on) => update({ quietHours: { ...prefs.quietHours, enabled: on } })}
          />
        </div>
        {prefs.quietHours.enabled && (
          <div className="flex items-center gap-3 text-sm">
            <Input
              type="time"
              aria-label={t("dndStart")}
              value={prefs.quietHours.start}
              onChange={(e) =>
                update({ quietHours: { ...prefs.quietHours, start: e.target.value } })
              }
              className="w-auto"
            />
            <span className="text-muted-foreground">→</span>
            <Input
              type="time"
              aria-label={t("dndEnd")}
              value={prefs.quietHours.end}
              onChange={(e) => update({ quietHours: { ...prefs.quietHours, end: e.target.value } })}
              className="w-auto"
            />
          </div>
        )}
      </div>

      {/* Per-source mute (exception model) */}
      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm">{t("perSourceLabel")}</Label>
        <p className="text-xs text-muted-foreground">{t("perSourceHint")}</p>
        <div className="grid grid-cols-2 gap-2 pt-1">
          {NOTIFICATION_SOURCES.map((s) => (
            <label
              key={s}
              className="flex cursor-pointer items-center justify-between rounded-md border p-2 text-sm"
            >
              <span className="truncate">{tSources(s)}</span>
              <Switch checked={sourceEnabled(s)} onCheckedChange={(on) => toggleSource(s, on)} />
            </label>
          ))}
        </div>
      </div>

      {/* Behaviour toggles */}
      <div className="space-y-3 border-t pt-4">
        {(
          [
            ["sound", prefs.sound, (on: boolean) => update({ sound: on })],
            ["badge", prefs.badge, (on: boolean) => update({ badge: on })],
            [
              "focusAware",
              prefs.connectorFocusAware,
              (on: boolean) => update({ connectorFocusAware: on }),
            ],
            [
              "snoozeAutoWake",
              prefs.snoozeAutoWakeOnActivity,
              (on: boolean) => update({ snoozeAutoWakeOnActivity: on }),
            ],
          ] as const
        ).map(([key, checked, onChange]) => (
          <div key={key} className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label className="text-sm">{t(`${key}Label`)}</Label>
              <p className="text-xs text-muted-foreground">{t(`${key}Hint`)}</p>
            </div>
            <Switch checked={checked} onCheckedChange={onChange} />
          </div>
        ))}
      </div>

      {/* Retention */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t("retentionDaysLabel")}</Label>
          <span className="text-sm tabular-nums text-muted-foreground">
            {Math.round(prefs.retentionMaxAgeMs / DAY_MS)}
          </span>
        </div>
        <Slider
          min={1}
          max={90}
          step={1}
          value={[Math.round(prefs.retentionMaxAgeMs / DAY_MS)]}
          onValueChange={(v) => update({ retentionMaxAgeMs: (v[0] ?? 30) * DAY_MS })}
        />
        <div className="flex items-center justify-between pt-1">
          <Label className="text-sm">{t("retentionItemsLabel")}</Label>
          <span className="text-sm tabular-nums text-muted-foreground">
            {prefs.retentionMaxItems}
          </span>
        </div>
        <Slider
          min={50}
          max={2000}
          step={50}
          value={[prefs.retentionMaxItems]}
          onValueChange={(v) => update({ retentionMaxItems: v[0] ?? 500 })}
        />
      </div>

      <div className="border-t pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void save({ notificationPreferences: { ...DEFAULT_NOTIFICATION_PREFERENCES } })
          }
        >
          <RotateCcwIcon className="mr-2 size-4" />
          {t("resetDefaults")}
        </Button>
      </div>
    </div>
  )
}

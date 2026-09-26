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
import { useSettingDraft } from "@/hooks/settings/use-setting-draft"
import { parseHmToMinutes } from "@/lib/appearance/auto-mode"
import { useSettingsStore } from "@/stores/settings"
import { NotificationDeliveryPanel } from "./notification-delivery-panel"
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

/** A complete "HH:MM", else `null`: a cleared or half-entered time field. */
const validTimeOfDay = (value: string): string | null =>
  parseHmToMinutes(value) === null ? null : value
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

  const write = (patch: Partial<NotificationPreferences>) =>
    save({ notificationPreferences: { ...prefs, ...patch } })
  const update = (patch: Partial<NotificationPreferences>) => {
    void write(patch)
  }

  // Quiet-hours times and the retention sliders are held locally and saved
  // once — a time on blur / Enter, a slider on release. `notificationPreferences`
  // is host-writable and this section opens on a paired phone at /settings, so
  // a save per change queued a host update for every intermediate time and
  // every step a drag crossed. An emptied or half-entered time reverts rather
  // than saving "" (which quiet-hours routing reads as midnight).
  const quietStart = useSettingDraft(
    prefs.quietHours.start,
    (start) => write({ quietHours: { ...prefs.quietHours, start } }),
    { normalize: validTimeOfDay }
  )
  const quietEnd = useSettingDraft(
    prefs.quietHours.end,
    (end) => write({ quietHours: { ...prefs.quietHours, end } }),
    { normalize: validTimeOfDay }
  )
  const retentionDays = useSettingDraft(Math.round(prefs.retentionMaxAgeMs / DAY_MS), (days) =>
    write({ retentionMaxAgeMs: days * DAY_MS })
  )
  const retentionItems = useSettingDraft(prefs.retentionMaxItems, (items) =>
    write({ retentionMaxItems: items })
  )

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
              value={quietStart.value}
              onChange={(e) => quietStart.set(e.target.value)}
              onBlur={quietStart.commit}
              onKeyDown={quietStart.commitOnEnter}
              className="w-auto"
            />
            <span className="text-muted-foreground">→</span>
            <Input
              type="time"
              aria-label={t("dndEnd")}
              value={quietEnd.value}
              onChange={(e) => quietEnd.set(e.target.value)}
              onBlur={quietEnd.commit}
              onKeyDown={quietEnd.commitOnEnter}
              className="w-auto"
            />
          </div>
        )}
      </div>

      {/* Per-source mute (exception model) */}
      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm">{t("perSourceLabel")}</Label>
        <p className="text-xs text-muted-foreground">{t("perSourceHint")}</p>
        {/* Two columns leave ~110px for a name beside a Switch; today's source
            labels fit, but they are localized and one longer word would start
            truncating the only thing that identifies the row. */}
        <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
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
            ["appBadge", prefs.appBadge, (on: boolean) => update({ appBadge: on })],
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
          <span className="text-sm tabular-nums text-muted-foreground">{retentionDays.value}</span>
        </div>
        <Slider
          min={1}
          max={90}
          step={1}
          aria-label={t("retentionDaysLabel")}
          value={[retentionDays.value]}
          onValueChange={([v]) => retentionDays.set(v ?? 30)}
          onValueCommit={([v]) => retentionDays.commitValue(v ?? 30)}
        />
        <div className="flex items-center justify-between pt-1">
          <Label className="text-sm">{t("retentionItemsLabel")}</Label>
          <span className="text-sm tabular-nums text-muted-foreground">{retentionItems.value}</span>
        </div>
        <Slider
          min={50}
          max={2000}
          step={50}
          aria-label={t("retentionItemsLabel")}
          value={[retentionItems.value]}
          onValueChange={([v]) => retentionItems.set(v ?? 500)}
          onValueCommit={([v]) => retentionItems.commitValue(v ?? 500)}
        />
      </div>

      {/* External delivery — V2 targets & subscriptions */}
      <div className="border-t pt-4">
        <NotificationDeliveryPanel />
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

"use client"

/**
 * Mobile Notification Center preferences (ADR-0056, Wave 2).
 *
 * Surfaces the portable subset of the desktop `notificationPreferences`
 * (`components/settings/notifications/notifications-section.tsx`) on the phone:
 * default channels, per-level OS/push gates, quiet hours, sound/badge/focus/
 * snooze behaviour, per-source mute, and retention. The OS push permission
 * itself is device-local and stays on the existing `NotificationPermissionCta`
 * (a native OS grant cannot be remote-written).
 *
 * The whole `notificationPreferences` object is one allowlisted key. Writes go
 * through `useSettingsPatch()` so a paired desktop applies them on next sync
 * (decision D7); the phone's own notification routing also consumes the value
 * locally. It is intentionally NOT in `CROSS_PLATFORM_SETTING_KEYS` — this is a
 * forward-only edit surface, matching the Wave-2 `composerBehavior` precedent.
 */

import { useTranslations } from "next-intl"

import { BiometricRow } from "@/components/mobile/me/biometric-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { useSettingDraft } from "@/hooks/settings/use-setting-draft"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { parseHmToMinutes } from "@/lib/appearance/auto-mode"
import { resolvePreferences } from "@/lib/notifications/preferences"
import { useSettingsStore } from "@/stores/settings"
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_LEVELS,
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
/** Fan-out channels the phone can toggle (`center` is always implied). */
const TOGGLE_CHANNELS: NotificationChannel[] = ["toast", "os", "push"]

export function NotificationPreferencesSection() {
  const t = useTranslations("mobile.notifications.preferences")
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsPatch()

  const prefs = resolvePreferences(settings?.notificationPreferences)

  const write = (next: Partial<NotificationPreferences>) =>
    update({ notificationPreferences: { ...prefs, ...next } })
  const patch = (next: Partial<NotificationPreferences>) => void write(next)

  // The quiet-hours times and the retention sliders are held locally and saved
  // once — a time on blur / Enter, a slider on release. Each save is its own
  // queued desktop update, and writing per change queued every intermediate
  // time and every step a drag crossed. A time field that is emptied or only
  // half-entered reverts rather than saving "" (which quiet-hours routing reads
  // as midnight).
  const retentionDays = Math.round(prefs.retentionMaxAgeMs / DAY_MS)
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
  const retentionDaysDraft = useSettingDraft(retentionDays, (days) =>
    write({ retentionMaxAgeMs: days * DAY_MS })
  )
  const retentionItems = useSettingDraft(prefs.retentionMaxItems, (items) =>
    write({ retentionMaxItems: items })
  )

  const hasChannel = (c: NotificationChannel) => prefs.globalDefaultChannels.includes(c)
  const toggleChannel = (c: NotificationChannel, on: boolean) => {
    const set = new Set(prefs.globalDefaultChannels)
    if (on) set.add(c)
    else set.delete(c)
    set.add("center") // center is always on
    patch({ globalDefaultChannels: [...set] })
  }

  const sourceEnabled = (s: NotificationSource) => prefs.perSource[s]?.enabled !== false
  const toggleSource = (s: NotificationSource, on: boolean) =>
    patch({ perSource: { ...prefs.perSource, [s]: { ...prefs.perSource[s], enabled: on } } })


  return (
    <div className="flex flex-col gap-4" data-testid="mobile-notification-preferences">
      <MeSection
        title={t("channelsTitle")}
        description={t("channelsHelp")}
        testid="me-section-notification-channels"
      >
        {TOGGLE_CHANNELS.map((c) => (
          <BiometricRow
            key={c}
            label={t(`channel.${c}`)}
            help={t(`channelHelp.${c}`)}
            checked={hasChannel(c)}
            onChange={(v) => toggleChannel(c, v)}
            testid={`notification-channel-${c}`}
          />
        ))}
      </MeSection>

      <MeSection title={t("gatesTitle")} testid="me-section-notification-gates">
        <Item size="sm" className="px-0">
          <ItemContent>
            <ItemTitle className="text-xs">{t("minOsLevel")}</ItemTitle>
            <ItemDescription className="text-[11px]">{t("minOsLevelHelp")}</ItemDescription>
            <Select
              value={prefs.minOsLevel}
              onValueChange={(v) => patch({ minOsLevel: v as NotificationLevel })}
            >
              <SelectTrigger
                data-testid="notification-min-os-level"
                aria-label={t("minOsLevel")}
                className="mt-1"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NOTIFICATION_LEVELS.map((lv) => (
                  <SelectItem key={lv} value={lv}>
                    {t(`level.${lv}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ItemContent>
        </Item>

        <Item size="sm" className="px-0">
          <ItemContent>
            <ItemTitle className="text-xs">{t("minPushLevel")}</ItemTitle>
            <ItemDescription className="text-[11px]">{t("minPushLevelHelp")}</ItemDescription>
            <Select
              value={prefs.minPushLevel}
              onValueChange={(v) => patch({ minPushLevel: v as NotificationLevel })}
            >
              <SelectTrigger
                data-testid="notification-min-push-level"
                aria-label={t("minPushLevel")}
                className="mt-1"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NOTIFICATION_LEVELS.map((lv) => (
                  <SelectItem key={lv} value={lv}>
                    {t(`level.${lv}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ItemContent>
        </Item>
      </MeSection>

      <MeSection
        title={t("quietHoursTitle")}
        description={t("quietHoursHelp")}
        testid="me-section-notification-quiet-hours"
      >
        <BiometricRow
          label={t("quietHoursEnabled")}
          help={t("quietHoursEnabledHelp")}
          checked={prefs.quietHours.enabled}
          onChange={(v) => patch({ quietHours: { ...prefs.quietHours, enabled: v } })}
          testid="notification-quiet-hours"
        />
        {prefs.quietHours.enabled && (
          <Item size="sm" className="px-0">
            <ItemContent>
              <div className="flex items-center gap-2 text-xs">
                <input
                  type="time"
                  aria-label={t("quietHoursStart")}
                  data-testid="notification-quiet-hours-start"
                  value={quietStart.value}
                  onChange={(e) => quietStart.set(e.target.value)}
                  onBlur={quietStart.commit}
                  onKeyDown={quietStart.commitOnEnter}
                  className="rounded-md border bg-background px-2 py-1"
                />
                <span className="text-muted-foreground">→</span>
                <input
                  type="time"
                  aria-label={t("quietHoursEnd")}
                  data-testid="notification-quiet-hours-end"
                  value={quietEnd.value}
                  onChange={(e) => quietEnd.set(e.target.value)}
                  onBlur={quietEnd.commit}
                  onKeyDown={quietEnd.commitOnEnter}
                  className="rounded-md border bg-background px-2 py-1"
                />
              </div>
            </ItemContent>
          </Item>
        )}
      </MeSection>

      <MeSection title={t("behaviourTitle")} testid="me-section-notification-behaviour">
        <BiometricRow
          label={t("sound")}
          help={t("soundHelp")}
          checked={prefs.sound}
          onChange={(v) => patch({ sound: v })}
          testid="notification-sound"
        />
        <BiometricRow
          label={t("badge")}
          help={t("badgeHelp")}
          checked={prefs.badge}
          onChange={(v) => patch({ badge: v })}
          testid="notification-badge"
        />
        <BiometricRow
          label={t("focusAware")}
          help={t("focusAwareHelp")}
          checked={prefs.connectorFocusAware}
          onChange={(v) => patch({ connectorFocusAware: v })}
          testid="notification-focus-aware"
        />
        <BiometricRow
          label={t("snoozeAutoWake")}
          help={t("snoozeAutoWakeHelp")}
          checked={prefs.snoozeAutoWakeOnActivity}
          onChange={(v) => patch({ snoozeAutoWakeOnActivity: v })}
          testid="notification-snooze-auto-wake"
        />
      </MeSection>

      <MeSection
        title={t("perSourceTitle")}
        description={t("perSourceHelp")}
        testid="me-section-notification-per-source"
      >
        {NOTIFICATION_SOURCES.map((s) => (
          <BiometricRow
            key={s}
            label={t(`source.${s}`)}
            help={t("sourceHelp")}
            checked={sourceEnabled(s)}
            onChange={(v) => toggleSource(s, v)}
            testid={`notification-source-${s}`}
          />
        ))}
      </MeSection>

      <MeSection title={t("retentionTitle")} testid="me-section-notification-retention">
        <Item size="sm" className="px-0">
          <ItemContent>
            <ItemTitle className="text-xs">
              {t("retentionDays")} · {t("days", { count: retentionDaysDraft.value })}
            </ItemTitle>
            <Slider
              value={[retentionDaysDraft.value]}
              min={1}
              max={90}
              step={1}
              onValueChange={([v]) => retentionDaysDraft.set(v ?? 30)}
              onValueCommit={([v]) => retentionDaysDraft.commitValue(v ?? 30)}
              data-testid="notification-retention-days"
              aria-label={t("retentionDays")}
              className="mt-2"
            />
            <ItemDescription className="text-[11px]">{t("retentionDaysHelp")}</ItemDescription>
          </ItemContent>
        </Item>
        <Item size="sm" className="px-0">
          <ItemContent>
            <ItemTitle className="text-xs">
              {t("retentionItems")} · {retentionItems.value}
            </ItemTitle>
            <Slider
              value={[retentionItems.value]}
              min={50}
              max={2000}
              step={50}
              onValueChange={([v]) => retentionItems.set(v ?? 500)}
              onValueCommit={([v]) => retentionItems.commitValue(v ?? 500)}
              data-testid="notification-retention-items"
              aria-label={t("retentionItems")}
              className="mt-2"
            />
          </ItemContent>
        </Item>
        <Item size="sm" className="px-0">
          <ItemActions>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void update({
                  notificationPreferences: { ...DEFAULT_NOTIFICATION_PREFERENCES },
                })
              }
              data-testid="notification-reset-defaults"
            >
              {t("resetDefaults")}
            </Button>
          </ItemActions>
        </Item>
      </MeSection>
    </div>
  )
}

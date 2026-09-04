"use client"

/**
 * Settings to Updates: the first-class home of the Update Center.
 *
 * About keeps a version summary and links here rather than owning a second
 * copy of the controls.
 */

import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { UpdateCenter } from "@/components/updates/update-center"
import { loggers } from "@cognia/logging"
import { readUpdateCenterSettings } from "@/lib/updates/runtime"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_UPDATE_CENTER_SETTINGS,
  USER_SELECTABLE_CHANNELS,
  type UpdateCenterSettings,
} from "@cognia/agent-config-types"

export function UpdatesSection() {
  const t = useTranslations("updates")
  const raw = useSettingsStore((s) => s.settings?.updateCenter)
  const save = useSettingsStore((s) => s.save)
  const settings: UpdateCenterSettings = { ...DEFAULT_UPDATE_CENTER_SETTINGS, ...(raw ?? {}) }

  const persist = async (patch: Partial<UpdateCenterSettings>) => {
    try {
      await save({ updateCenter: { ...readUpdateCenterSettings(), ...patch } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      loggers.app.error("updates.settingsSaveFailed", error)
      toast.error(t("settings.saveFailed", { error: message }))
    }
  }

  return (
    <div className="space-y-6" data-testid="updates-section">
      <div>
        <h2 className="text-base font-medium">{t("title")}</h2>
        <p className="text-sm text-pretty text-muted-foreground">{t("description")}</p>
      </div>

      <UpdateCenter autoCheck />

      <Separator />

      <div className="divide-y">
        <div className="flex flex-col justify-between gap-2 py-3 sm:flex-row sm:items-center">
          <div className="space-y-0.5">
            <Label htmlFor="update-channel" className="text-sm">
              {t("settings.channelLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("settings.channelDescription")}</p>
          </div>
          <Select
            value={settings.channel === "canary" ? "beta" : settings.channel}
            onValueChange={(value) =>
              void persist({ channel: value as UpdateCenterSettings["channel"] })
            }
          >
            <SelectTrigger
              id="update-channel"
              className="w-40 shrink-0"
              aria-label={t("settings.channelLabel")}
              data-testid="update-channel"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USER_SELECTABLE_CHANNELS.map((channel) => (
                <SelectItem key={channel} value={channel}>
                  {t(`settings.channel.${channel}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col justify-between gap-2 py-3 sm:flex-row sm:items-center">
          <div className="space-y-0.5">
            <Label htmlFor="update-background-download" className="text-sm">
              {t("settings.backgroundDownloadLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.backgroundDownloadDescription")}
            </p>
          </div>
          <Switch
            id="update-background-download"
            checked={settings.backgroundDownloadDesktop}
            onCheckedChange={(backgroundDownloadDesktop) =>
              void persist({ backgroundDownloadDesktop })
            }
            aria-label={t("settings.backgroundDownloadLabel")}
            data-testid="update-background-download"
          />
        </div>

        <div className="flex flex-col justify-between gap-2 py-3 sm:flex-row sm:items-center">
          <div className="space-y-0.5">
            <Label htmlFor="update-notify-critical" className="text-sm">
              {t("settings.notifyCriticalLabel")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.notifyCriticalDescription")}
            </p>
          </div>
          <Switch
            id="update-notify-critical"
            checked={settings.notifyCritical}
            onCheckedChange={(notifyCritical) => void persist({ notifyCritical })}
            aria-label={t("settings.notifyCriticalLabel")}
            data-testid="update-notify-critical"
          />
        </div>
      </div>
    </div>
  )
}

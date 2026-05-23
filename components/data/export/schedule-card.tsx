"use client"

// Settings card for the auto-backup schedule. Toggles the feature, sets the
// interval and retention, and (Tauri-only) picks a destination folder. The
// scheduler's actual runner lives in `BackupSchedulerProvider`.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { CalendarClockIcon, FolderIcon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { DEFAULT_BACKUP_AUTO_SCHEDULE } from "@/lib/claude/types"
import { toast } from "sonner"
import { createLogger } from "@/lib/logging"

const log = createLogger("data-backup-schedule")

export function ScheduleCard() {
  const t = useTranslations("settings.data.backup.schedule")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const config = settings?.backupAutoSchedule ?? DEFAULT_BACKUP_AUTO_SCHEDULE
  const reminderDays = settings?.backupReminderDays ?? 7
  const [busy, setBusy] = useState(false)

  const update = async (next: Partial<typeof config>) => {
    setBusy(true)
    try {
      await save({ backupAutoSchedule: { ...config, ...next } })
    } catch (error) {
      log.error("schedule-save-failed", { error, patch: Object.keys(next) })
      throw error
    } finally {
      setBusy(false)
    }
  }

  const pickFolder = async () => {
    if (!isTauri()) return
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const picked = await open({ directory: true, multiple: false })
      if (typeof picked === "string") {
        await update({ dirPath: picked })
        toast.success(t("folderSet"))
      }
    } catch (error) {
      log.error("schedule-folder-pick-failed", { error })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <CalendarClockIcon className="size-4" />
        <Label className="text-sm">{t("title")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("body")}</p>

      <label className="flex items-center justify-between text-sm">
        <span>
          <span className="font-medium">{t("enableLabel")}</span>
          <span className="block text-[11px] text-muted-foreground">{t("enableHint")}</span>
        </span>
        <Switch
          checked={config.enabled}
          onCheckedChange={(v) => void update({ enabled: v })}
          disabled={busy}
        />
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[11px]">{t("intervalLabel")}</Label>
          <Input
            type="number"
            min={1}
            max={30}
            value={config.intervalDays}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) void update({ intervalDays: Math.max(1, Math.min(30, v)) })
            }}
            disabled={busy}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">{t("retainLabel")}</Label>
          <Input
            type="number"
            min={1}
            max={50}
            value={config.retainCount}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) void update({ retainCount: Math.max(1, Math.min(50, v)) })
            }}
            disabled={busy}
          />
        </div>
      </div>

      {isTauri() && (
        <div className="space-y-1">
          <Label className="text-[11px]">{t("folderLabel")}</Label>
          <div className="flex gap-2">
            <Input value={config.dirPath ?? ""} readOnly placeholder={t("folderPlaceholder")} />
            <Button variant="outline" size="sm" onClick={() => void pickFolder()}>
              <FolderIcon className="mr-1 size-4" />
              {t("pickFolder")}
            </Button>
          </div>
        </div>
      )}
      {!isTauri() && (
        <p className="rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">
          {t("webOnlyNote")}
        </p>
      )}

      <div className="space-y-1 border-t pt-3">
        <Label className="text-[11px]">{t("reminderLabel")}</Label>
        <Input
          type="number"
          min={0}
          max={90}
          value={reminderDays}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) {
              save({ backupReminderDays: Math.max(0, Math.min(90, v)) }).catch((error) =>
                log.error("reminder-days-save-failed", { error })
              )
            }
          }}
        />
        <p className="text-[11px] text-muted-foreground">{t("reminderHint")}</p>
      </div>
    </Card>
  )
}

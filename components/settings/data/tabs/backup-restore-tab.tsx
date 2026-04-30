"use client"

// Full-database export / import + scheduling. Two scheduling models coexist:
//
//   1. ScheduleCard — interval-based, settings-driven. Drives the
//      `BackupSchedulerProvider` 30-min loop. One global schedule.
//   2. CronScheduleBlock — cron-based, scheduler-driven. Each task is a
//      `ScheduledTask` with type=`backup`, runs through the standard
//      task-scheduler tab-lock + retries, surfaced under Settings →
//      Scheduled Tasks. Many tasks possible.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  CalendarClockIcon,
  CalendarIcon,
  DownloadIcon,
  FileArchiveIcon,
  KeyRoundIcon,
} from "lucide-react"
import { toast } from "sonner"
import { EncryptionOptions, type EncryptionMode } from "@/components/data/shared/encryption-options"
import { FullRestoreDialog } from "@/components/data/import/full-restore-dialog"
import { BatchExportDialog } from "@/components/data/export/batch-export-dialog"
import { ScheduleCard } from "@/components/data/export/schedule-card"
import { BackupScheduleDialog } from "@/components/scheduler/backup-schedule-dialog"
import { useFullBackup } from "@/hooks/data/use-full-backup"
import { useScheduler } from "@/hooks/scheduler"
import { rotateBackupKey } from "@/lib/data/backup-key"
import { loggers } from "@/lib/logger"

export function BackupRestoreTab() {
  return (
    <div className="space-y-6">
      <ExportBlock />
      <ScheduleCard />
      <CronScheduleBlock />
      <QuickSessionExportBlock />
      <RotateKeyBlock />
      <FullRestoreDialog />
    </div>
  )
}

function ExportBlock() {
  const t = useTranslations("settings.data")
  const [includeSessions, setIncludeSessions] = useState(false)
  const [includeApiKey, setIncludeApiKey] = useState(false)
  const [encryption, setEncryption] = useState<EncryptionMode>("plaintext")
  const [passphrase, setPassphrase] = useState("")
  const { run, busy } = useFullBackup()

  const onExport = async () => {
    if (encryption === "passphrase" && !passphrase) {
      toast.error(t("backup.passphraseRequired"))
      return
    }
    loggers.export.info("full_backup_initiated", {
      includeSessions,
      includeApiKey,
      encryption,
      passphraseSet: Boolean(passphrase),
    })
    const result = await run({
      includeSessions,
      includeApiKey,
      encryption,
      passphrase,
    })
    if (result.ok) {
      if (!result.canceled) {
        loggers.export.info("full_backup_completed", {
          includeSessions,
          includeApiKey,
          encryption,
        })
        toast.success(t("exportSuccess"))
      } else {
        loggers.export.info("full_backup_canceled")
      }
    } else {
      loggers.export.error("full_backup_failed", undefined, { error: result.error, encryption })
      toast.error(result.error)
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <DownloadIcon className="size-4" />
        <Label className="text-sm">{t("exportTitle")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("exportHint")}</p>

      <div className="space-y-2 pt-1">
        <label className="flex items-start gap-2 text-sm">
          <Switch checked={includeSessions} onCheckedChange={setIncludeSessions} />
          <span>
            <span className="font-medium">{t("includeSessions")}</span>
            <span className="block text-[11px] text-muted-foreground">
              {t("includeSessionsHint")}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Switch checked={includeApiKey} onCheckedChange={setIncludeApiKey} />
          <span>
            <span className="font-medium">{t("includeApiKey")}</span>
            <span className="block text-[11px] text-muted-foreground">
              {t("includeApiKeyHint")}
            </span>
          </span>
        </label>
      </div>

      <EncryptionOptions
        mode={encryption}
        onModeChange={setEncryption}
        passphrase={passphrase}
        onPassphraseChange={setPassphrase}
        disabled={busy}
      />

      <div className="flex justify-end">
        <Button size="sm" onClick={() => void onExport()} disabled={busy}>
          {busy ? t("exporting") : t("exportButton")}
        </Button>
      </div>
    </Card>
  )
}

function CronScheduleBlock() {
  const t = useTranslations("settings.data")
  const tScheduler = useTranslations("scheduler")
  const { tasks } = useScheduler()
  const backupTasks = tasks.filter((task) => task.type === "backup")

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <CalendarClockIcon className="size-4" />
        <Label className="text-sm">{t("schedule.title")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("schedule.desc")}</p>

      {backupTasks.length > 0 && (
        <div className="space-y-1.5 rounded-md border bg-muted/30 p-2 text-xs">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("schedule.currentCount", { count: backupTasks.length })}
          </p>
          <ul className="space-y-1">
            {backupTasks.map((task) => (
              <li key={task.id} className="flex items-center justify-between">
                <span className="truncate">{task.name}</span>
                <Badge
                  variant={task.status === "active" ? "default" : "outline"}
                  className="text-[10px]"
                >
                  {task.status}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end">
        <BackupScheduleDialog
          trigger={
            <Button variant="outline" size="sm">
              <CalendarIcon className="mr-1.5 size-3.5" />
              {tScheduler("backup.schedule")}
            </Button>
          }
        />
      </div>
    </Card>
  )
}

function QuickSessionExportBlock() {
  const t = useTranslations("settings.data")
  return (
    <Card className="space-y-2 p-4">
      <div className="flex items-center gap-2">
        <FileArchiveIcon className="size-4" />
        <Label className="text-sm">{t("backup.quickSessionTitle")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("backup.quickSessionBody")}</p>
      <div className="flex justify-end">
        <BatchExportDialog
          trigger={
            <Button variant="outline" size="sm">
              {t("backup.quickSessionButton")}
            </Button>
          }
        />
      </div>
    </Card>
  )
}

function RotateKeyBlock() {
  const t = useTranslations("settings.data")
  const [busy, setBusy] = useState(false)
  const onRotate = async () => {
    setBusy(true)
    try {
      loggers.export.warn("backup_key_rotate_initiated")
      const next = await rotateBackupKey()
      if (next) {
        loggers.export.warn("backup_key_rotate_succeeded")
        toast.success(t("backup.rotateKeySuccess"))
      } else {
        loggers.export.error("backup_key_rotate_failed")
        toast.error(t("backup.rotateKeyFailed"))
      }
    } catch (err) {
      loggers.export.error("backup_key_rotate_threw", err)
      throw err
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-2 p-4">
      <div className="flex items-center gap-2">
        <KeyRoundIcon className="size-4" />
        <Label className="text-sm">{t("backup.rotateKeyTitle")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("backup.rotateKeyBody")}</p>
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => void onRotate()} disabled={busy}>
          {t("backup.rotateKeyButton")}
        </Button>
      </div>
    </Card>
  )
}

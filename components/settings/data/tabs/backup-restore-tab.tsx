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
  Link2Icon,
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
import {
  buildBackupPackage,
  serializePackage,
  defaultExportFileName,
} from "@/lib/data/build-package"
import { loggers } from "@cognia/logging"
import { ShareSettingsCard } from "@/components/share/share-settings-card"
import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { backupPayload } from "@/lib/share/payload"
import type { SharePayload } from "@/lib/share/types"
import { scanBackupForShare, type BackupShareScan } from "@/lib/share/backup-share-gate"
import { BackupShareScanDialog } from "@/components/settings/data/backup-share-scan-dialog"
import { encryptBackupPackage } from "@/lib/data/crypto"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { attachPortableRetrievalKeys } from "@/lib/data/retrieval-key-backup"
import type { BackupPackageV3, EncryptedEnvelopeV1 } from "@/lib/data/types"
import { WebDavSyncCard } from "@/components/settings/data/webdav-sync-card"
import { GithubBackupCard } from "@/components/settings/data/github-backup-card"
import { GoogleDriveBackupCard } from "@/components/settings/data/google-drive-backup-card"
import { requireBiometric } from "@/lib/biometric/prompt"

export function BackupRestoreTab() {
  return (
    <div className="space-y-6">
      <ExportBlock />
      <ScheduleCard />
      <CronScheduleBlock />
      <QuickSessionExportBlock />
      <RotateKeyBlock />
      <ShareSettingsCard />
      <WebDavSyncCard />
      <GithubBackupCard />
      <GoogleDriveBackupCard />
      <FullRestoreDialog />
    </div>
  )
}

function ExportBlock() {
  const t = useTranslations("settings.data")
  const tShare = useTranslations("share")
  const [includeSessions, setIncludeSessions] = useState(false)
  const [includeApiKey, setIncludeApiKey] = useState(false)
  const [includeBuiltIns, setIncludeBuiltIns] = useState(false)
  const [encryption, setEncryption] = useState<EncryptionMode>("auto-key")
  const [passphrase, setPassphrase] = useState("")
  const { run, busy } = useFullBackup()
  // Share link state. The package is built once when the owner clicks share,
  // scanned by the PII gate, and the same bytes are what the link carries.
  const [sharePayload, setSharePayload] = useState<SharePayload | null>(null)
  const [shareScan, setShareScan] = useState<BackupShareScan | null>(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [preparingShare, setPreparingShare] = useState(false)

  const onPrepareShare = async () => {
    if (encryption === "passphrase" && !passphrase) {
      toast.error(t("backup.passphraseRequired"))
      return
    }
    setPreparingShare(true)
    try {
      const sharePassphrase =
        encryption === "plaintext"
          ? undefined
          : encryption === "passphrase"
            ? passphrase
            : await getDefaultBackupPassphrase()
      if (encryption !== "plaintext" && !sharePassphrase) {
        toast.error(t("backup.shareScan.keyUnavailable"))
        return
      }
      const basePackage = await buildBackupPackage({
        includeSessions,
        includeApiKey,
        includeBuiltIns,
      })
      const pkg = sharePassphrase
        ? await attachPortableRetrievalKeys(basePackage, sharePassphrase)
        : basePackage
      const plaintext = serializePackage(pkg)
      let artifact: BackupPackageV3 | EncryptedEnvelopeV1 = pkg
      let serialized = plaintext
      if (sharePassphrase) {
        const envelope = await encryptBackupPackage(plaintext, sharePassphrase, {
          version: pkg.manifest.version,
          schemaVersion: pkg.manifest.schemaVersion,
          traceId: pkg.manifest.traceId,
          exportedAt: pkg.manifest.exportedAt,
          appVersion: pkg.manifest.appVersion,
          backend: pkg.manifest.backend,
          encryption: { enabled: true, format: "encrypted-envelope-v1" },
        })
        artifact = envelope
        serialized = JSON.stringify(envelope, null, 2)
      }
      const scan = scanBackupForShare(artifact)
      loggers.export.info("backup_share_scanned", {
        encryption,
        scan: scan.kind,
        hits: scan.kind === "hits" ? scan.total : 0,
        domains: scan.kind === "hits" ? scan.domains.map((entry) => entry.domain) : [],
      })
      setSharePayload(
        backupPayload(
          serialized,
          defaultExportFileName(new Date(), sharePassphrase ? "encrypted" : "plain")
        )
      )
      setShareScan(scan)
      if (scan.kind === "hits") setScanOpen(true)
      else setShareOpen(true)
    } catch (err) {
      loggers.export.error("backup_share_prepare_failed", undefined, {
        error: err instanceof Error ? err.message : String(err),
        encryption,
      })
      toast.error(t("backup.shareScan.prepareFailed"))
    } finally {
      setPreparingShare(false)
    }
  }

  const onScanConfirmed = () => {
    loggers.export.warn("backup_share_pii_confirmed", {
      hits: shareScan?.kind === "hits" ? shareScan.total : 0,
    })
    setScanOpen(false)
    setShareOpen(true)
  }

  const onExport = async () => {
    if (encryption === "passphrase" && !passphrase) {
      toast.error(t("backup.passphraseRequired"))
      return
    }
    let plaintextConfirmed = false
    if (encryption === "plaintext") {
      const confirmation = await requireBiometric({
        title: t("backup.plaintextConfirmTitle"),
        message: t("backup.plaintextConfirmBody"),
        confirmLabel: t("backup.plaintextConfirmAction"),
        cancelLabel: t("cancel"),
      })
      if (!confirmation.ok) {
        loggers.export.warn("plaintext_backup_cancelled")
        return
      }
      plaintextConfirmed = true
      loggers.export.warn("plaintext_backup_confirmed", {
        includeSessions,
        includeApiKey,
        includeBuiltIns,
        verification: confirmation.via,
      })
    }
    loggers.export.info("full_backup_initiated", {
      includeSessions,
      includeApiKey,
      includeBuiltIns,
      encryption,
      passphraseSet: Boolean(passphrase),
    })
    const result = await run({
      includeSessions,
      includeApiKey,
      includeBuiltIns,
      encryption,
      passphrase,
      plaintextConfirmed,
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
        <label className="flex items-start gap-2 text-sm">
          <Switch checked={includeBuiltIns} onCheckedChange={setIncludeBuiltIns} />
          <span>
            <span className="font-medium">{t("includeBuiltIns")}</span>
            <span className="block text-[11px] text-muted-foreground">
              {t("includeBuiltInsHint")}
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

      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || preparingShare}
          onClick={() => void onPrepareShare()}
          data-testid="backup-share-button"
        >
          <Link2Icon className="mr-1.5 size-4" />
          {preparingShare ? t("backup.shareScan.preparing") : tShare("shareAction")}
        </Button>
        <BackupShareScanDialog
          open={scanOpen}
          onOpenChange={setScanOpen}
          domains={shareScan?.kind === "hits" ? shareScan.domains : []}
          total={shareScan?.kind === "hits" ? shareScan.total : 0}
          onConfirm={onScanConfirmed}
        />
        <ShareLinkDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          buildPayload={() => {
            if (!sharePayload) throw new Error("Backup share payload was not prepared")
            return sharePayload
          }}
          artifactSummary={
            shareScan && shareScan.kind !== "hits" ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid={`backup-share-note-${shareScan.kind}`}
              >
                {t(`backup.shareScan.${shareScan.kind}`)}
              </p>
            ) : undefined
          }
        />
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

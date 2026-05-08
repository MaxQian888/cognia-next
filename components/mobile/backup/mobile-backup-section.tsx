"use client"

/**
 * Mobile Backup section (Wave 3.3).
 *
 * Three responsibilities:
 *   1. Export now → buildBackupPackage → encryptBackupPackage → write to
 *      `Documents/cognia/backups/<timestamp>.cog.bak` via
 *      `lib/capacitor/filesystem.writeFile` (or LocalStorage on web).
 *   2. Import → web file input → JSON.parse → migrateEnvelope → applyBackupPackage.
 *   3. Auto-backup toggle + interval — persisted to settings; the
 *      desktop's BackupSchedulerProvider keeps doing the work, but on
 *      mobile we ALSO schedule a LocalNotifications reminder so users
 *      know to keep the desktop online.
 *
 * Strict pre-condition: only the *encryption* path is exposed in mobile;
 * unencrypted exports stay desktop-only because phones tend to forward
 * Documents to iCloud/Drive automatically.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckCircle2Icon, CloudUploadIcon, DownloadIcon, ImportIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { writeFile } from "@/lib/capacitor/filesystem"
import { ensureChannel, schedule as scheduleLocalNotif } from "@/lib/capacitor/local-notifications"
import { detectNativePlatform } from "@/lib/capacitor/_shared"
import { applyBackupPackage } from "@/lib/data/apply-package"
import { buildBackupPackage } from "@/lib/data/build-package"
import { encryptBackupPackage } from "@/lib/data/crypto"
import { migrateEnvelope } from "@/lib/data/migrate"
import type { ImportMergeStrategy } from "@/lib/data/types"
import { listBackupHistory } from "@/lib/db/backup-history"
import type { BackupHistoryRow } from "@/lib/db/backup-history"
import { cn } from "@/lib/utils"

const DEFAULT_PASSPHRASE = "mobile-auto-key" // Replaced by user input or settings.
const NOTIF_ID_DAILY = 91_001

function tsFilename(now = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `cognia-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.cog.bak`
}

function utf8ToBase64(s: string): string {
  if (typeof btoa !== "undefined") {
    return btoa(unescape(encodeURIComponent(s)))
  }
  return Buffer.from(s, "utf8").toString("base64")
}

export interface MobileBackupSectionProps {
  className?: string
}

export function MobileBackupSection({ className }: MobileBackupSectionProps) {
  const t = useTranslations("mobile.backup")
  const tNotif = useTranslations("mobile.offline")
  const isMobile = detectNativePlatform() === "mobile"

  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [strategy, setStrategy] = useState<ImportMergeStrategy>("skip")
  const [passphrase, setPassphrase] = useState("")
  const [autoBackup, setAutoBackup] = useState(false)
  const [intervalDays, setIntervalDays] = useState(7)

  const history = useLiveQuery<BackupHistoryRow[]>(() => listBackupHistory(), []) ?? []

  // Schedule a daily LocalNotifications reminder when auto-backup flips on.
  useEffect(() => {
    if (!autoBackup) return
    void (async () => {
      await ensureChannel({ id: "cognia-default", name: tNotif("notifChannel") })
      await scheduleLocalNotif([
        {
          id: NOTIF_ID_DAILY,
          title: t("autoBackup"),
          body: t("autoBackupHint"),
          schedule: { every: "day", count: 1 },
        },
      ])
    })()
  }, [autoBackup, t, tNotif])

  const onExport = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const pkg = await buildBackupPackage({
        mergeStrategy: "skip",
        includeSessions: true,
        includeApiKey: false,
        includeBuiltIns: false,
      } as never)
      const plaintext = JSON.stringify(pkg)
      const envelope = await encryptBackupPackage(
        plaintext,
        passphrase || DEFAULT_PASSPHRASE,
        pkg.manifest
      )
      const json = JSON.stringify(envelope)
      const path = `cognia/backups/${tsFilename()}`

      const out = await writeFile({
        path,
        data: utf8ToBase64(json),
        encoding: "base64",
        directory: "documents",
        recursive: true,
      })
      if (out.kind === "ok") {
        toast.success(t("exportSuccess", { path: out.value.uri }))
      } else if (out.kind === "unsupported") {
        // Web fallback — trigger a download via Blob URL.
        const blob = new Blob([json], { type: "application/octet-stream" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = tsFilename()
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        toast.success(t("exportSuccess", { path: a.download }))
      } else {
        toast.error(t("exportFailed", { message: out.message }))
      }
    } catch (err) {
      toast.error(t("exportFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setExporting(false)
    }
  }

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || importing) return
    setImporting(true)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as unknown
      const pkg = await migrateEnvelope(parsed)
      await applyBackupPackage(pkg, {
        mergeStrategy: strategy,
        includeSessions: true,
        includeApiKey: false,
      })
      toast.success(t("importSuccess"))
    } catch (err) {
      toast.error(t("importFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setImporting(false)
      e.target.value = ""
    }
  }

  return (
    <div className={cn("flex flex-col gap-4", className)} data-testid="mobile-backup-section">
      {/* Export card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <CloudUploadIcon className="size-4" />
            {t("title")}
          </CardTitle>
          <CardDescription className="text-xs">{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label className="flex flex-col gap-1 text-xs font-medium">
            <span>{t("passphraseLabel")}</span>
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="••••••••"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              data-testid="backup-passphrase"
            />
          </Label>
          <Button type="button" onClick={onExport} disabled={exporting} data-testid="backup-export">
            {exporting ? <span>{t("exporting")}</span> : <span>{t("exportNow")}</span>}
          </Button>
          {!isMobile ? (
            <p className="text-[11px] text-muted-foreground">
              Web mode: backup downloads as a regular file.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Import card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ImportIcon className="size-4" />
            {t("importPick")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label className="flex flex-col gap-1 text-xs font-medium">
            <span>{t("importStrategy")}</span>
            <Select value={strategy} onValueChange={(v) => setStrategy(v as ImportMergeStrategy)}>
              <SelectTrigger data-testid="backup-strategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="skip">{t("strategySkip")}</SelectItem>
                <SelectItem value="overwrite">{t("strategyOverwrite")}</SelectItem>
                <SelectItem value="duplicate">{t("strategyDuplicate")}</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          <label className="block">
            <input
              type="file"
              accept=".bak,.json,.cog,application/octet-stream,application/json"
              className="sr-only"
              onChange={onImportFile}
              data-testid="backup-import-input"
            />
            <span
              className={cn(
                "touch-target inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-input px-3 text-sm",
                importing && "opacity-60"
              )}
            >
              <DownloadIcon className="size-4" />
              {importing ? t("importing") : t("importPick")}
            </span>
          </label>
        </CardContent>
      </Card>

      {/* Auto-backup */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
            <span>{t("autoBackup")}</span>
            <Switch
              checked={autoBackup}
              onCheckedChange={setAutoBackup}
              data-testid="backup-auto-toggle"
              aria-label={t("autoBackup")}
            />
          </CardTitle>
          <CardDescription className="text-xs">{t("autoBackupHint")}</CardDescription>
        </CardHeader>
        {autoBackup ? (
          <CardContent>
            <Label className="flex flex-col gap-1 text-xs">
              <span>{t("autoBackupInterval")}</span>
              <Input
                type="number"
                min={1}
                max={30}
                value={intervalDays}
                onChange={(e) => setIntervalDays(Number(e.target.value) || 1)}
                data-testid="backup-auto-interval"
              />
            </Label>
          </CardContent>
        ) : null}
      </Card>

      {/* History */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">{t("historyHeader")}</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("historyEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {history.slice(0, 8).map((row) => (
                <li
                  key={row.id}
                  className="flex items-center gap-2 text-xs"
                  data-testid={`backup-history-${row.id}`}
                >
                  <CheckCircle2Icon
                    className={cn(
                      "size-3.5",
                      row.success ? "text-emerald-500" : "text-destructive"
                    )}
                  />
                  <span className="text-muted-foreground">
                    {new Date(row.completedAt).toLocaleString()}
                  </span>
                  {!row.success ? (
                    <Badge variant="outline" className="text-[10px]">
                      {row.errorMessage ?? "failed"}
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

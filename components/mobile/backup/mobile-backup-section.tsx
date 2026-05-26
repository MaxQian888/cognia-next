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
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemDescription, ItemMedia } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { useBiometricGuard } from "@/hooks/use-biometric-guard"
import { share } from "@/lib/capacitor/share"
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
import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"

const NOTIF_ID_DAILY = 91_001
const MIN_PASSPHRASE_LENGTH = 8
const MS_PER_DAY = 24 * 60 * 60 * 1000

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
  const guard = useBiometricGuard()
  const biometricRequired =
    useSettingsStore((s) => s.settings?.biometricRequiredFor?.exportBackup) ?? false

  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [strategy, setStrategy] = useState<ImportMergeStrategy>("skip")
  const [passphrase, setPassphrase] = useState("")
  const [autoBackup, setAutoBackup] = useState(false)
  const [intervalDays, setIntervalDays] = useState(7)

  const history = useLiveQuery<BackupHistoryRow[]>(() => listBackupHistory(), []) ?? []
  const passphraseValid = passphrase.length >= MIN_PASSPHRASE_LENGTH
  const reduce = useReducedMotion()

  const runExport = async () => {
    const pkg = await buildBackupPackage({
      mergeStrategy: "skip",
      includeSessions: true,
      includeApiKey: false,
      includeBuiltIns: false,
    } as never)
    const plaintext = JSON.stringify(pkg)
    const envelope = await encryptBackupPackage(plaintext, passphrase, pkg.manifest)
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
      toast.success(t("exportSuccess", { path: out.value.uri }), {
        action: {
          label: t("shareFile"),
          onClick: () => {
            void share({ title: t("shareTitle"), files: [out.value.uri] })
          },
        },
      })
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
  }

  const onExport = async () => {
    if (exporting) return
    if (!passphraseValid) return
    setExporting(true)
    try {
      if (biometricRequired) {
        const outcome = await guard(
          {
            reason: t("exportBiometricReason"),
            title: t("exportBiometricTitle"),
            fallthroughWhenUnavailable: true,
          },
          runExport
        )
        if (outcome.kind === "blocked" && outcome.reason !== "cancelled") {
          toast.error(t("biometricBlocked", { reason: outcome.reason }))
        }
      } else {
        await runExport()
      }
    } catch (err) {
      toast.error(t("exportFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setExporting(false)
    }
  }

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

  // Fire a real backup at every `intervalDays`-day boundary while the app
  // is alive. The notif above is the fallback for when the app is closed.
  // We probe the existing backup history on mount so a freshly-mounted
  // session that's overdue triggers immediately rather than waiting the
  // full interval again.
  useEffect(() => {
    if (!autoBackup) return
    if (!passphraseValid) return
    if (intervalDays <= 0) return

    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null

    const lastSuccessAt = (() => {
      for (const row of history) {
        if (row.success) return row.completedAt
      }
      return 0
    })()

    const fireIfOverdue = () => {
      if (cancelled) return
      const now = Date.now()
      const due = lastSuccessAt === 0 ? now : lastSuccessAt + intervalDays * MS_PER_DAY
      if (now >= due) {
        void onExport()
      }
    }

    fireIfOverdue()
    interval = setInterval(fireIfOverdue, MS_PER_DAY)
    return () => {
      cancelled = true
      if (interval !== null) clearInterval(interval)
    }
    // `history` and `onExport` change every render but the interval only
    // needs to re-arm on the toggle / interval / passphrase boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBackup, intervalDays, passphraseValid])

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
              minLength={MIN_PASSPHRASE_LENGTH}
              data-testid="backup-passphrase"
              aria-invalid={passphrase.length > 0 && !passphraseValid}
              aria-describedby="backup-passphrase-help"
            />
            <span
              id="backup-passphrase-help"
              className={cn(
                "text-[11px]",
                passphraseValid ? "text-muted-foreground" : "text-destructive"
              )}
              data-testid="backup-passphrase-help"
            >
              {t("passphraseRequiredHint", { min: MIN_PASSPHRASE_LENGTH })}
            </span>
          </Label>
          <Button
            type="button"
            onClick={onExport}
            disabled={exporting || !passphraseValid}
            data-testid="backup-export"
          >
            {exporting ? <span>{t("exporting")}</span> : <span>{t("exportNow")}</span>}
          </Button>
          {!isMobile ? (
            <p className="text-[11px] text-muted-foreground">{t("webModeNote")}</p>
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
          <Button asChild variant="outline" className={cn(importing && "opacity-60")}>
            <label className="touch-target cursor-pointer">
              <DownloadIcon />
              {importing ? t("importing") : t("importPick")}
              <input
                type="file"
                accept=".bak,.json,.cog,application/octet-stream,application/json"
                className="sr-only"
                onChange={onImportFile}
                data-testid="backup-import-input"
              />
            </label>
          </Button>
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
            <motion.ul
              role="list"
              aria-label={t("historyHeader")}
              className="flex flex-col gap-1"
              initial={reduce ? false : "initial"}
              animate="animate"
              variants={STAGGER_CONTAINER}
            >
              {history.slice(0, 8).map((row) => (
                <motion.li key={row.id} variants={STAGGER_CHILD}>
                  <Item size="sm" className="px-0 py-1" data-testid={`backup-history-${row.id}`}>
                    <ItemMedia className="bg-transparent">
                      <CheckCircle2Icon
                        aria-hidden="true"
                        className={cn(
                          "size-3.5",
                          row.success ? "text-emerald-500" : "text-destructive"
                        )}
                      />
                    </ItemMedia>
                    <ItemContent>
                      <ItemDescription className="text-xs">
                        {new Date(row.completedAt).toLocaleString()}
                      </ItemDescription>
                    </ItemContent>
                    {!row.success ? (
                      <Badge variant="destructive" className="text-[10px]">
                        {row.errorMessage ?? t("historyFailedLabel")}
                      </Badge>
                    ) : null}
                  </Item>
                </motion.li>
              ))}
            </motion.ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

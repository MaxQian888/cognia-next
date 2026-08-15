"use client"

// Cron-driven scheduled backup dialog. Creates a `ScheduledTask` with type
// `backup` so it routes through the regular scheduler (tab-locked, retried,
// surfaced under Settings → Scheduled Tasks). Remote destinations (WebDAV,
// GitHub, Google Drive) are offered as configured in Settings → Data; a
// destination that is not configured yet is shown disabled with a hint
// (Working Rule 7 — inert, never hidden). `convex` is deprecated and gone.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  DatabaseIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useScheduler } from "@/hooks/scheduler"
import {
  describeBackupDestinationReadiness,
  type BackupDestinationReadiness,
} from "@/lib/data/destinations/config"
import {
  type BackupDestination,
  type BackupTaskPayload,
  type BackupTaskType,
  DEFAULT_EXECUTION_CONFIG,
} from "@/types/scheduler"
import { TimezoneSelect } from "./timezone-select"

type BackupType = Exclude<BackupTaskType, "plugins">

const SCHEDULE_PRESETS: Array<{ id: string; expression: string; labelKey: string }> = [
  { id: "daily-2am", expression: "0 2 * * *", labelKey: "daily" },
  { id: "weekly-sunday-2am", expression: "0 2 * * 0", labelKey: "weekly" },
  { id: "monthly-1st-2am", expression: "0 2 1 * *", labelKey: "monthly" },
  { id: "every-6-hours", expression: "0 */6 * * *", labelKey: "every6h" },
]

interface BackupScheduleDialogProps {
  trigger?: React.ReactNode
  onScheduled?: (taskId: string) => void
}

export function BackupScheduleDialog({ trigger, onScheduled }: BackupScheduleDialogProps) {
  const t = useTranslations("scheduler")
  const tCommon = useTranslations("common")
  const { createTask } = useScheduler()

  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [taskName, setTaskName] = useState("Scheduled Backup")
  const [cronExpression, setCronExpression] = useState("0 2 * * *")
  const [timezone, setTimezone] = useState("UTC")
  const [backupType, setBackupType] = useState<BackupType>("full")
  const [destination, setDestination] = useState<BackupDestination>("local")
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [readiness, setReadiness] = useState<BackupDestinationReadiness[] | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void describeBackupDestinationReadiness()
      .then((rows) => {
        if (!cancelled) setReadiness(rows)
      })
      .catch(() => {
        if (!cancelled) setReadiness(null)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const readinessOf = (target: BackupDestination): BackupDestinationReadiness["state"] =>
    readiness?.find((row) => row.destination === target)?.state ?? "not-configured"

  const [maxRetries, setMaxRetries] = useState(DEFAULT_EXECUTION_CONFIG.maxRetries)
  const [retryDelay, setRetryDelay] = useState(DEFAULT_EXECUTION_CONFIG.retryDelay)
  const [maxMissedRuns, setMaxMissedRuns] = useState(DEFAULT_EXECUTION_CONFIG.maxMissedRuns ?? 1)
  const [runMissedOnStartup, setRunMissedOnStartup] = useState(
    DEFAULT_EXECUTION_CONFIG.runMissedOnStartup
  )
  const [allowConcurrent, setAllowConcurrent] = useState(DEFAULT_EXECUTION_CONFIG.allowConcurrent)

  const [includeSessions, setIncludeSessions] = useState(true)
  const [includeSettings, setIncludeSettings] = useState(true)
  const [includeArtifacts, setIncludeArtifacts] = useState(true)
  const [includeIndexedDB, setIncludeIndexedDB] = useState(true)
  const [notifyOnComplete, setNotifyOnComplete] = useState(true)
  const [notifyOnError, setNotifyOnError] = useState(true)

  const handleSubmit = useCallback(async () => {
    if (!taskName.trim()) return
    setSubmitting(true)
    try {
      const task = await createTask({
        name: taskName.trim(),
        type: "backup",
        trigger: { type: "cron", cronExpression, timezone },
        payload: {
          backupType,
          destination,
          options: {
            includeSessions,
            includeSettings,
            includeArtifacts,
            includeIndexedDB,
          },
        } satisfies BackupTaskPayload,
        notification: {
          onStart: false,
          onComplete: notifyOnComplete,
          onError: notifyOnError,
          onProgress: false,
          channels: ["toast", "desktop"],
        },
        config: {
          timeout: DEFAULT_EXECUTION_CONFIG.timeout,
          maxRetries,
          retryDelay,
          runMissedOnStartup,
          maxMissedRuns: Math.max(0, maxMissedRuns),
          allowConcurrent,
        },
      })
      if (task) {
        onScheduled?.(task.id)
        setOpen(false)
      }
    } finally {
      setSubmitting(false)
    }
  }, [
    taskName,
    cronExpression,
    timezone,
    backupType,
    destination,
    includeSessions,
    includeSettings,
    includeArtifacts,
    includeIndexedDB,
    notifyOnComplete,
    notifyOnError,
    maxRetries,
    retryDelay,
    maxMissedRuns,
    runMissedOnStartup,
    allowConcurrent,
    createTask,
    onScheduled,
  ])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm">
            <CalendarIcon className="mr-2 size-4" />
            {t("backup.schedule")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DatabaseIcon className="size-5" />
            {t("backup.scheduleTitle")}
          </DialogTitle>
          <DialogDescription>{t("backup.scheduleDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="backup-name">{t("taskName")}</Label>
            <Input
              id="backup-name"
              value={taskName}
              onChange={(e) => setTaskName(e.target.value)}
              placeholder={t("backup.namePlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("backup.scheduleFrequency")}</Label>
            <Select value={cronExpression} onValueChange={setCronExpression}>
              <SelectTrigger>
                <SelectValue placeholder={t("selectPreset")} />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.expression}>
                    {t(`backup.preset.${preset.labelKey}` as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <ClockIcon className="size-4 text-muted-foreground" />
              <Input
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="0 2 * * *"
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("timezone")}</Label>
              <TimezoneSelect
                value={timezone}
                onValueChange={setTimezone}
                testId="backup-schedule-timezone"
                includeOffset
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("backup.type")}</Label>
            <Select value={backupType} onValueChange={(v) => setBackupType(v as BackupType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">{t("backup.types.full")}</SelectItem>
                <SelectItem value="sessions">{t("backup.types.sessions")}</SelectItem>
                <SelectItem value="settings">{t("backup.types.settings")}</SelectItem>
                <SelectItem value="all">{t("backup.types.all")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("backup.destination")}</Label>
            <Select
              value={destination}
              onValueChange={(v) => setDestination(v as BackupDestination)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">{t("backup.destinations.local")}</SelectItem>
                <SelectItem value="webdav">{t("backup.destinations.webdav")}</SelectItem>
                <SelectItem
                  value="github"
                  disabled={readinessOf("github") !== "ready"}
                  data-testid="backup-destination-github"
                >
                  {t("backup.destinations.github")}
                  {readinessOf("github") !== "ready"
                    ? ` — ${t("backup.destinationNotConfigured")}`
                    : ""}
                </SelectItem>
                <SelectItem
                  value="googledrive"
                  disabled={readinessOf("googledrive") !== "ready"}
                  data-testid="backup-destination-googledrive"
                >
                  {t("backup.destinations.googledrive")}
                  {readinessOf("googledrive") !== "ready"
                    ? ` — ${t("backup.destinationNotConfigured")}`
                    : ""}
                </SelectItem>
                <SelectItem value="all">{t("backup.destinations.all")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {destination === "local"
                ? t("backup.destinationLocalHint")
                : destination === "webdav"
                  ? t("backup.destinationWebdavHint")
                  : destination === "github"
                    ? t("backup.destinationGithubHint")
                    : destination === "googledrive"
                      ? t("backup.destinationGoogleDriveHint")
                      : t("backup.destinationAllHint")}
            </p>
          </div>

          {backupType === "full" && (
            <div className="space-y-3 rounded-lg border p-3">
              <Label className="text-sm font-medium">{t("backup.includeOptions")}</Label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id="include-sessions"
                    checked={includeSessions}
                    onCheckedChange={(c) => setIncludeSessions(c === true)}
                  />
                  <Label htmlFor="include-sessions">{t("backup.options.sessions")}</Label>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id="include-settings"
                    checked={includeSettings}
                    onCheckedChange={(c) => setIncludeSettings(c === true)}
                  />
                  <Label htmlFor="include-settings">{t("backup.options.settings")}</Label>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id="include-artifacts"
                    checked={includeArtifacts}
                    onCheckedChange={(c) => setIncludeArtifacts(c === true)}
                  />
                  <Label htmlFor="include-artifacts">{t("backup.options.artifacts")}</Label>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id="include-indexeddb"
                    checked={includeIndexedDB}
                    onCheckedChange={(c) => setIncludeIndexedDB(c === true)}
                  />
                  <Label htmlFor="include-indexeddb">{t("backup.options.indexedDB")}</Label>
                </div>
              </div>
            </div>
          )}

          <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="outline" className="w-full justify-between">
                <span>{t("advancedSettings")}</span>
                {showAdvanced ? (
                  <ChevronUpIcon className="size-4" />
                ) : (
                  <ChevronDownIcon className="size-4" />
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-3 rounded-lg border bg-muted/20 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">{t("maxRetries")}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={maxRetries}
                    onChange={(e) => setMaxRetries(parseInt(e.target.value, 10) || 0)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("retryDelayMs")}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={retryDelay}
                    onChange={(e) => setRetryDelay(parseInt(e.target.value, 10) || 0)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("maxMissedRuns")}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={maxMissedRuns}
                    onChange={(e) => setMaxMissedRuns(parseInt(e.target.value, 10) || 0)}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span>{t("runMissedOnStartup")}</span>
                <Switch checked={runMissedOnStartup} onCheckedChange={setRunMissedOnStartup} />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span>{t("allowConcurrent")}</span>
                <Switch checked={allowConcurrent} onCheckedChange={setAllowConcurrent} />
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="space-y-3">
            <Label>{t("notificationSettings.title")}</Label>
            <div className="flex items-center justify-between text-sm">
              <span>{t("notificationSettings.onComplete")}</span>
              <Switch checked={notifyOnComplete} onCheckedChange={setNotifyOnComplete} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span>{t("notificationSettings.onError")}</span>
              <Switch checked={notifyOnError} onCheckedChange={setNotifyOnError} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            <XIcon className="mr-2 size-4" />
            {tCommon("cancel")}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting || !taskName.trim()}>
            <CalendarIcon className="mr-2 size-4" />
            {submitting ? t("scheduling") : t("schedule")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

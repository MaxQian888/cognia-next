"use client"

// Cleanup + destructive operations + privacy controls. Top-down:
//   • Storage cleanup — Quick / Custom / Deep dialog (preview + commit)
//   • Clear data — wipe one or more Dexie tables (typed-DELETE confirm)
//   • Privacy — telemetry toggle + keyring-migration preview note

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { clearAll, clearTables, type ClearableTable } from "@/lib/data/clear"
import { useSettingsStore } from "@/stores/settings"
import { toast } from "sonner"
import { createLogger } from "@cognia/logging"

const log = createLogger("settings.data.maintenance")
import { RotateCcwIcon, ShieldAlertIcon, ShieldIcon, Trash2Icon } from "lucide-react"
import { StorageCleanupDialog } from "@/components/data/storage/storage-cleanup-dialog"
import { useStorageBreakdown } from "@/hooks/storage"
import {
  getBehaviorTelemetrySettings,
  setBehaviorTelemetryEnabled,
} from "@/lib/telemetry/events/settings"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import {
  listWorkspaceMaintenanceEvents,
  runWorkspaceMaintenance,
} from "@/lib/task-workspace/client"
import type { WorkspaceMaintenanceEvent } from "@/lib/task-workspace/types"

const CLEAR_TARGETS: { value: ClearableTable | "all"; label: string }[] = [
  { value: "sessions", label: "Conversations + messages" },
  { value: "characters", label: "Characters (built-ins re-seed)" },
  { value: "skills", label: "Skills (built-ins re-seed)" },
  { value: "teams", label: "Teams (built-ins re-seed)" },
  { value: "promptPresets", label: "System prompt presets" },
  { value: "mcpServers", label: "MCP servers" },
  { value: "settings", label: "App settings (resets to defaults)" },
  { value: "all", label: "Everything (entire database)" },
]

export function MaintenanceTab() {
  return (
    <div className="space-y-6">
      <CleanupBlock />
      <WorkspaceMaintenanceBlock />
      <RetentionBlock />
      <ClearBlock />
      <PrivacyBlock />
    </div>
  )
}

function WorkspaceMaintenanceBlock() {
  const t = useTranslations("settings.data.workspaceMaintenance")
  const [events, setEvents] = useState<WorkspaceMaintenanceEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const next = await listWorkspaceMaintenanceEvents(20)
    setEvents(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    void listWorkspaceMaintenanceEvents(20).then(
      (next) => {
        if (!cancelled) setEvents(next)
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      await runWorkspaceMaintenance()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      className="space-y-3 p-4"
      data-testid="workspace-maintenance"
      data-last-event-detail={events[0]?.detail}
    >
      <div className="flex items-center gap-2">
        <RotateCcwIcon className="size-4" />
        <Label className="text-sm">{t("title")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {t("error", { error })}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {events.length > 0
            ? t("lastEvent", {
                kind: t(`kinds.${events[0].kind}`),
                detail: events[0].detail,
              })
            : t("noEvents")}
        </span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
          {busy ? t("running") : t("runNow")}
        </Button>
      </div>
    </Card>
  )
}

function RetentionBlock() {
  const t = useTranslations("settings.data.retention")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const days = settings?.storageRetention?.traceRetentionDays ?? 30
  const [draft, setDraft] = useState<string>(String(days))

  const commit = (raw: string) => {
    // A number input only ever yields a numeric string or empty; `|| 0` maps
    // an empty / unparseable entry to 0 (keep forever).
    const next = Math.max(0, Math.floor(Number(raw) || 0))
    setDraft(String(next))
    void save({ storageRetention: { traceRetentionDays: next } })
    log.info("trace_retention_changed", { days: next })
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <RotateCcwIcon className="size-4" />
        <Label className="text-sm" htmlFor="trace-retention-days">
          {t("title")}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("desc")}</p>
      <div className="flex items-center gap-2">
        <Input
          id="trace-retention-days"
          type="number"
          min={0}
          inputMode="numeric"
          className="w-24"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">{t("unit")}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("zeroHint")}</p>
    </Card>
  )
}

function CleanupBlock() {
  const t = useTranslations("settings.data.cleanup")
  const { formatBytes, refresh } = useStorageBreakdown()
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <RotateCcwIcon className="size-4" />
        <Label className="text-sm">{t("title")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("desc")}</p>
      <div className="flex justify-end">
        <StorageCleanupDialog
          formatBytes={formatBytes}
          onCleanupComplete={() => void refresh()}
          trigger={
            <Button variant="outline" size="sm">
              <Trash2Icon className="mr-1.5 size-3.5" />
              {t("button")}
            </Button>
          }
        />
      </div>
    </Card>
  )
}

function ClearBlock() {
  const t = useTranslations("settings.data")
  const [target, setTarget] = useState<ClearableTable | "all">("sessions")
  const [confirm, setConfirm] = useState("")
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    try {
      if (target === "all") {
        log.warn("clear_all_initiated")
        await clearAll()
        log.warn("clear_all_completed")
        toast.success(t("clearAllSuccess"))
        setTimeout(() => window.location.reload(), 250)
      } else {
        log.info("clear_table_initiated", { table: target })
        await clearTables([target])
        log.info("clear_table_completed", { table: target })
        toast.success(t("clearSuccess"))
      }
      setOpen(false)
      setConfirm("")
    } catch (err) {
      log.error("clear_failed", err, { target })
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3 border-destructive/50 p-4">
      <div className="flex items-center gap-2 text-destructive">
        <Trash2Icon className="size-4" />
        <Label className="text-sm">{t("clearTitle")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("clearHint")}</p>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label className="text-[11px]">{t("clearTargetLabel")}</Label>
          <Select value={target} onValueChange={(v) => setTarget(v as ClearableTable | "all")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLEAR_TARGETS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">
              {t("clearButton")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <ShieldAlertIcon className="size-4 text-destructive" />
                {t("clearConfirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>{t("clearConfirmBody")}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1">
              <Label className="text-xs">{t("typeToConfirm")}</Label>
              <Input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                // i18n-exempt: type-to-confirm token must match the required literal input
                placeholder="DELETE"
                autoFocus
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                disabled={confirm !== "DELETE" || busy}
                onClick={(e) => {
                  e.preventDefault()
                  void run()
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {busy ? t("clearing") : t("clearConfirmAction")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Card>
  )
}

function PrivacyBlock() {
  const t = useTranslations("settings.data")
  const save = useSettingsStore((s) => s.save)
  const canonicalTelemetryEnabled = useSettingsStore(
    (s) => s.settings?.behaviorTelemetry?.enabled ?? s.settings?.telemetryEnabled
  )
  const telemetryEnabled = canonicalTelemetryEnabled ?? getBehaviorTelemetrySettings().enabled

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <ShieldIcon className="size-4" />
        <Label className="text-sm">{t("privacyTitle")}</Label>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("telemetryLabel")}</p>
          <p className="text-xs text-muted-foreground">{t("telemetryHint")}</p>
        </div>
        <Switch
          checked={telemetryEnabled}
          onCheckedChange={(v) => {
            log.info("telemetry_toggled", { enabled: v })
            if (!v) void trackEvent("telemetry.preference.changed", { enabled: false })
            const behaviorTelemetry = setBehaviorTelemetryEnabled(v)
            if (v) void trackEvent("telemetry.preference.changed", { enabled: true })
            void save({ telemetryEnabled: v, behaviorTelemetry })
          }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{t("keyringFollowup")}</p>
    </Card>
  )
}

"use client"

// Cleanup + destructive operations + privacy controls. Top-down:
//   • Storage cleanup — Quick / Custom / Deep dialog (preview + commit)
//   • Clear data — wipe one or more Dexie tables (typed-DELETE confirm)
//   • Privacy — telemetry toggle + keyring-migration preview note

import { useState } from "react"
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
import { createLogger } from "@/lib/logger"

const log = createLogger("settings.data.maintenance")
import { RotateCcwIcon, ShieldAlertIcon, ShieldIcon, Trash2Icon } from "lucide-react"
import { StorageCleanupDialog } from "@/components/data/storage/storage-cleanup-dialog"
import { useStorageBreakdown } from "@/hooks/storage"

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
      <ClearBlock />
      <PrivacyBlock />
    </div>
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
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const telemetryEnabled = Boolean(settings?.telemetryEnabled)

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <ShieldIcon className="size-4" />
        <Label className="text-sm">{t("privacyTitle")}</Label>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">{t("telemetryLabel")}</p>
          <p className="text-xs text-muted-foreground">{t("telemetryHint")}</p>
        </div>
        <Switch
          checked={telemetryEnabled}
          onCheckedChange={(v) => {
            log.info("telemetry_toggled", { enabled: v })
            void save({ telemetryEnabled: v })
          }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{t("keyringFollowup")}</p>
    </Card>
  )
}

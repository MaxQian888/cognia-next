"use client"

/**
 * Wiki Index card — drives the External Bridge wiki rebuild orchestrator
 * from the Settings → External Bridge surface.
 *
 * Every user-visible string is routed through `useTranslations` so the card
 * stays in lock-step with locale switches (the previous version had 17
 * hard-coded English strings that bypassed i18n entirely).
 */

import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { BookOpenIcon, Loader2Icon, RotateCwIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getWikiManifest } from "@/lib/db/wiki-manifest"
import { isTauri } from "@/lib/tauri"
import {
  runWikiRebuild,
  WebModeError,
  NoApiKeyError,
  type RunRebuildOptions,
} from "@/lib/wiki/rebuild-runner"
import type { RebuildResult } from "@/lib/wiki/orchestrator"
import type { WikiManifest, WikiScheduleMode, WikiScheduleSettings } from "@/types/wiki"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { syncWikiCronToScheduler } from "@/lib/wiki/schedule/cron-bridge"

export function WikiRebuildCard() {
  const t = useTranslations("settings.externalBridge.wikiIndex")
  const [busy, setBusy] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [force, setForce] = useState(false)
  const [lastResult, setLastResult] = useState<RebuildResult | null>(null)

  const manifest = useLiveQuery<WikiManifest | undefined>(
    async () => getWikiManifest("cognia-self"),
    []
  )

  // Schedule state — hydrated once from AppSettings.externalBridge.wikiSchedule.
  const [schedule, setSchedule] = useState<WikiScheduleSettings>({ mode: "off" })
  const [scheduleSaving, setScheduleSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const row = await getSettings()
        const persisted = row.externalBridge?.wikiSchedule
        if (persisted && !cancelled) setSchedule(persisted)
      } catch {
        // Best-effort — defaults to off.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onSaveSchedule = useCallback(async () => {
    setScheduleSaving(true)
    try {
      const current = await getSettings()
      const next = {
        ...(current.externalBridge ?? { enabled: false, enabledScopes: [] }),
        wikiSchedule: schedule,
      }
      await saveSettings({ externalBridge: next })
      const result = await syncWikiCronToScheduler(schedule)
      if (result.action === "invalid") {
        toast.error(t("scheduleInvalidCron", { expression: result.invalidExpression ?? "" }))
      } else if (result.action === "deleted") {
        toast.success(t("scheduleCleared"))
      } else if (result.action === "created" || result.action === "updated") {
        toast.success(t(`scheduleAction.${result.action}`))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setScheduleSaving(false)
    }
  }, [schedule, t])

  const formatTime = useCallback(
    (ts: number | undefined): string => {
      if (!ts) return t("never")
      return new Date(ts).toLocaleString()
    },
    [t]
  )

  const formatDuration = useCallback((ms: number): string => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }, [])

  const onRebuild = useCallback(async () => {
    setShowConfirm(false)
    setBusy(true)
    setLastResult(null)
    try {
      const opts: RunRebuildOptions = { force }
      const result = await runWikiRebuild(opts)
      setLastResult(result)
      const parts: string[] = []
      if (result.added > 0) parts.push(t("summaryAdded", { count: result.added }))
      if (result.changed > 0) parts.push(t("summaryChanged", { count: result.changed }))
      if (result.removed > 0) parts.push(t("summaryRemoved", { count: result.removed }))
      if (result.errors.length > 0) parts.push(t("summaryErrors", { count: result.errors.length }))
      const summary = parts.length > 0 ? parts.join(", ") : t("summaryNoChanges")
      toast.success(t("toastRebuilt", { summary, duration: formatDuration(result.durationMs) }))
    } catch (err) {
      if (err instanceof WebModeError) {
        toast.error(t("webModeWarning"))
      } else if (err instanceof NoApiKeyError) {
        toast.error(t("noApiKeyError"))
      } else {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(t("toastRebuildFailed", { message }))
      }
    } finally {
      setBusy(false)
    }
  }, [force, formatDuration, t])

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
            <span className="flex items-center gap-2">
              <BookOpenIcon className="h-4 w-4" />
              {t("title")}
              {busy && <Loader2Icon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowConfirm(true)}
              disabled={busy || !isTauri()}
              aria-label={t("rebuildAria")}
            >
              <RotateCwIcon className="h-3.5 w-3.5 mr-1" />
              {t("rebuildWiki")}
            </Button>
          </CardTitle>
          <CardDescription className="text-xs">
            {isTauri() ? t("description") : t("descriptionWeb")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {/* Status rows */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <div>
              <Label className="text-xs text-muted-foreground">{t("scope")}</Label>
              <p className="font-mono text-xs">cognia-self</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("lastBuild")}</Label>
              <p className="text-xs">{formatTime(manifest?.lastBuildAt)}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("articleCount")}</Label>
              <p className="text-xs">{manifest?.articleCount ?? 0}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("generator")}</Label>
              <p className="font-mono text-xs">{manifest?.generatorVersion ?? "—"}</p>
            </div>
          </div>

          {/* Force rebuild toggle */}
          <div className="flex items-center justify-between rounded border bg-card px-3 py-2">
            <div>
              <Label className="text-xs">{t("forceRebuild")}</Label>
              <p className="text-xs text-muted-foreground">{t("forceRebuildDesc")}</p>
            </div>
            <Switch
              checked={force}
              onCheckedChange={setForce}
              disabled={busy}
              aria-label={t("forceRebuildAria")}
            />
          </div>

          {/* Schedule sub-section */}
          <div
            className="space-y-3 rounded border bg-card px-3 py-3"
            data-testid="wiki-schedule-section"
          >
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-medium">{t("scheduleTitle")}</Label>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onSaveSchedule()}
                disabled={scheduleSaving || !isTauri()}
                aria-label={t("scheduleSaveAria")}
                data-testid="wiki-schedule-save"
              >
                {scheduleSaving ? (
                  <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t("scheduleSave")
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("scheduleHelp")}</p>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">
                  {t("scheduleModeLabel")}
                </Label>
                <Select
                  value={schedule.mode}
                  onValueChange={(v) => setSchedule({ ...schedule, mode: v as WikiScheduleMode })}
                  disabled={scheduleSaving}
                >
                  <SelectTrigger
                    className="h-8 text-xs"
                    aria-label={t("scheduleModeLabel")}
                    data-testid="wiki-schedule-mode"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">{t("scheduleMode.off")}</SelectItem>
                    <SelectItem value="daily">{t("scheduleMode.daily")}</SelectItem>
                    <SelectItem value="weekly">{t("scheduleMode.weekly")}</SelectItem>
                    <SelectItem value="custom">{t("scheduleMode.custom")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {schedule.mode === "custom" ? (
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">
                    {t("scheduleCustomCronLabel")}
                  </Label>
                  <Input
                    value={schedule.customCron ?? ""}
                    onChange={(e) => setSchedule({ ...schedule, customCron: e.target.value })}
                    placeholder="0 3 * * *"
                    className="h-8 font-mono text-xs"
                    disabled={scheduleSaving}
                    aria-label={t("scheduleCustomCronLabel")}
                    data-testid="wiki-schedule-custom-cron"
                  />
                </div>
              ) : (
                <div className="flex flex-col justify-end">
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={schedule.force === true}
                      onChange={(e) => setSchedule({ ...schedule, force: e.target.checked })}
                      disabled={scheduleSaving || schedule.mode === "off"}
                      aria-label={t("scheduleForceAria")}
                      data-testid="wiki-schedule-force"
                    />
                    {t("scheduleForceLabel")}
                  </label>
                </div>
              )}
            </div>
          </div>

          {/* Last rebuild result */}
          {lastResult && (
            <div className="rounded border bg-card px-3 py-2 text-xs">
              <p className="font-medium mb-1">
                {t("rebuildResult", { duration: formatDuration(lastResult.durationMs) })}
              </p>
              <div className="grid grid-cols-5 gap-2 text-center">
                <div>
                  <p className="font-mono text-emerald-500">{lastResult.added}</p>
                  <p className="text-muted-foreground">{t("resultAdded")}</p>
                </div>
                <div>
                  <p className="font-mono text-amber-500">{lastResult.changed}</p>
                  <p className="text-muted-foreground">{t("resultChanged")}</p>
                </div>
                <div>
                  <p className="font-mono text-red-500">{lastResult.removed}</p>
                  <p className="text-muted-foreground">{t("resultRemoved")}</p>
                </div>
                <div>
                  <p className="font-mono text-muted-foreground">{lastResult.unchanged}</p>
                  <p className="text-muted-foreground">{t("resultUnchanged")}</p>
                </div>
                <div>
                  <p className="font-mono text-red-500">{lastResult.errors.length}</p>
                  <p className="text-muted-foreground">{t("resultErrors")}</p>
                </div>
              </div>
              {lastResult.errors.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-muted-foreground">
                    {t("errorListSummary", { count: lastResult.errors.length })}
                  </summary>
                  <ul className="mt-1 space-y-1">
                    {lastResult.errors.map((e, i) => (
                      <li key={i} className="flex items-start gap-1 text-red-500">
                        <TriangleAlertIcon className="h-3 w-3 mt-0.5 shrink-0" />
                        <span className="font-mono">
                          {e.module}: {e.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmation dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("rebuildConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {force ? t("rebuildConfirmDescForce") : t("rebuildConfirmDesc")}{" "}
              {t("rebuildConfirmCommonHint")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirm(false)}>
              {t("rebuildCancel")}
            </Button>
            <Button onClick={onRebuild}>{t("rebuildWiki")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

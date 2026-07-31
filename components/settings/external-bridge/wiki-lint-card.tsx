"use client"

/**
 * Wiki Lint card — runs the orphan-page + broken-link health check from the
 * Settings → External Bridge surface, shows the latest findings, and manages
 * an optional cron schedule. Mirrors {@link WikiRebuildCard}; unlike rebuild,
 * the lint pass reads only Dexie so it is not Tauri-gated.
 */

import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Loader2Icon, ScanSearchIcon, TriangleAlertIcon, UnlinkIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getWikiLintResult } from "@/lib/db/wiki-lint-results"
import { runWikiLint } from "@/lib/wiki/lint/lint-runner"
import { syncWikiLintCronToScheduler } from "@/lib/wiki/lint/lint-cron-bridge"
import { getSettings, saveSettings } from "@/lib/db/settings"
import type { WikiLintResult, WikiScheduleMode, WikiScheduleSettings } from "@/types/wiki"

export function WikiLintCard() {
  const t = useTranslations("settings.externalBridge.wikiLint")
  const [busy, setBusy] = useState(false)

  const result = useLiveQuery<WikiLintResult | undefined>(
    async () => getWikiLintResult("cognia-self"),
    []
  )

  const [schedule, setSchedule] = useState<WikiScheduleSettings>({ mode: "off" })
  const [scheduleSaving, setScheduleSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const row = await getSettings()
        const persisted = row.externalBridge?.wikiLintSchedule
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
        wikiLintSchedule: schedule,
      }
      await saveSettings({ externalBridge: next })
      const action = await syncWikiLintCronToScheduler(schedule)
      if (action.action === "invalid") {
        toast.error(t("scheduleInvalidCron", { expression: action.invalidExpression ?? "" }))
      } else if (action.action === "deleted") {
        toast.success(t("scheduleCleared"))
      } else if (action.action === "created" || action.action === "updated") {
        toast.success(t(`scheduleAction.${action.action}`))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setScheduleSaving(false)
    }
  }, [schedule, t])

  const formatTime = useCallback(
    (ts: number | undefined): string => (ts ? new Date(ts).toLocaleString() : t("never")),
    [t]
  )

  const onLint = useCallback(async () => {
    setBusy(true)
    try {
      const r = await runWikiLint("cognia-self")
      if (r.orphans.length === 0 && r.brokenLinks.length === 0) {
        toast.success(t("toastClean", { count: r.articleCount }))
      } else {
        toast.success(t("toastLinted", { orphans: r.orphans.length, broken: r.brokenLinks.length }))
      }
    } catch (err) {
      toast.error(
        t("toastLintFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }, [t])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <ScanSearchIcon className="h-4 w-4" />
            {t("title")}
            {busy && <Loader2Icon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onLint()}
            disabled={busy}
            aria-label={t("runAria")}
          >
            <ScanSearchIcon className="h-3.5 w-3.5 mr-1" />
            {t("run")}
          </Button>
        </CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* Status grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <div>
            <Label className="text-xs text-muted-foreground">{t("lastRun")}</Label>
            <p className="text-xs">{formatTime(result?.lastRunAt)}</p>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("articleCount")}</Label>
            <p className="text-xs">{result?.articleCount ?? 0}</p>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("orphanCount")}</Label>
            <p className="text-xs font-mono text-amber-500">{result?.orphans.length ?? 0}</p>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("brokenCount")}</Label>
            <p className="text-xs font-mono text-red-500">{result?.brokenLinks.length ?? 0}</p>
          </div>
        </div>

        {/* Findings */}
        {result && (result.orphans.length > 0 || result.brokenLinks.length > 0) && (
          <div className="space-y-2 rounded border bg-card px-3 py-2 text-xs">
            {result.brokenLinks.length > 0 && (
              <details open>
                <summary className="cursor-pointer text-red-500">
                  {t("brokenListSummary", { count: result.brokenLinks.length })}
                </summary>
                <ul className="mt-1 space-y-1">
                  {result.brokenLinks.map((f) => (
                    <li key={f.slug} className="flex items-start gap-1">
                      <UnlinkIcon className="h-3 w-3 mt-0.5 shrink-0 text-red-500" />
                      <span className="font-mono">
                        {f.slug} → {(f.deadLinks ?? []).join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {result.orphans.length > 0 && (
              <details>
                <summary className="cursor-pointer text-amber-500">
                  {t("orphanListSummary", { count: result.orphans.length })}
                </summary>
                <ul className="mt-1 space-y-1">
                  {result.orphans.map((f) => (
                    <li key={f.slug} className="flex items-start gap-1">
                      <TriangleAlertIcon className="h-3 w-3 mt-0.5 shrink-0 text-amber-500" />
                      <span className="font-mono">{f.slug}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {/* Schedule sub-section */}
        <div
          className="space-y-3 rounded border bg-card px-3 py-3"
          data-testid="wiki-lint-schedule-section"
        >
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs font-medium">{t("scheduleTitle")}</Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void onSaveSchedule()}
              disabled={scheduleSaving}
              aria-label={t("scheduleSaveAria")}
              data-testid="wiki-lint-schedule-save"
            >
              {scheduleSaving ? (
                <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t("scheduleSave")
              )}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("scheduleHelp")}</p>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">{t("scheduleModeLabel")}</Label>
            <Select
              value={schedule.mode}
              onValueChange={(v) => setSchedule({ ...schedule, mode: v as WikiScheduleMode })}
              disabled={scheduleSaving}
            >
              <SelectTrigger
                className="h-8 text-xs"
                aria-label={t("scheduleModeLabel")}
                data-testid="wiki-lint-schedule-mode"
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
          {schedule.mode === "custom" && (
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
                data-testid="wiki-lint-schedule-custom-cron"
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

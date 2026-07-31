"use client"

/**
 * Attention Radar panel — the pet console's "Insights" tab. Shows the latest
 * 7-dimension info-diet report, a "Run now" trigger, and a folded-in config /
 * schedule section (so radar setup lives with the feature rather than needing a
 * separate Settings-nav entry).
 */

import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Loader2Icon, SparklesIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getLatestRadarReport } from "@/lib/db/radar-reports"
import { runRadarReport, NoRadarModelError } from "@/lib/radar/radar-runner"
import { syncRadarCronToScheduler } from "@/lib/radar/radar-cron-bridge"
import { getSettings, saveSettings } from "@/lib/db/settings"
import {
  DEFAULT_RADAR_SETTINGS,
  type RadarReport,
  type RadarScheduleMode,
  type RadarSettings,
} from "@/types/radar"

export function RadarPanel() {
  const t = useTranslations("radar")
  const [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState<RadarSettings>(DEFAULT_RADAR_SETTINGS)
  const [saving, setSaving] = useState(false)

  const report = useLiveQuery<RadarReport | undefined>(() => getLatestRadarReport("self"), [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const row = await getSettings()
        if (!cancelled && row.attentionRadar) setSettings(row.attentionRadar)
      } catch {
        // Best-effort — keep defaults.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onRun = useCallback(async () => {
    setBusy(true)
    try {
      const r = await runRadarReport({ force: true })
      toast.success(r ? t("toast.generated") : t("toast.skipped"))
    } catch (err) {
      if (err instanceof NoRadarModelError) toast.error(t("toast.noModel"))
      else
        toast.error(
          t("toast.failed", { message: err instanceof Error ? err.message : String(err) })
        )
    } finally {
      setBusy(false)
    }
  }, [t])

  const onSaveSettings = useCallback(async () => {
    setSaving(true)
    try {
      await saveSettings({ attentionRadar: settings })
      const action = await syncRadarCronToScheduler(settings.schedule)
      if (action.action === "invalid") {
        toast.error(
          t("settings.scheduleInvalidCron", { expression: action.invalidExpression ?? "" })
        )
      } else if (action.action === "deleted") {
        toast.success(t("settings.scheduleCleared"))
      } else if (action.action === "created" || action.action === "updated") {
        toast.success(t(`settings.scheduleAction.${action.action}`))
      } else {
        toast.success(t("settings.saved"))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [settings, t])

  const scheduleMode = settings.schedule?.mode ?? "off"

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <SparklesIcon className="h-4 w-4" />
          {t("panel.title")}
        </h2>
        <Button
          size="sm"
          onClick={() => void onRun()}
          disabled={busy}
          aria-label={t("panel.runAria")}
        >
          {busy ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> : t("panel.run")}
        </Button>
      </div>

      {report ? (
        <RadarReportView report={report} t={t} />
      ) : (
        <p className="rounded border bg-card px-3 py-6 text-center text-sm text-muted-foreground">
          {t("panel.empty")}
        </p>
      )}

      {/* Config + schedule */}
      <div className="space-y-3 rounded border bg-card px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label className="text-xs font-medium">{t("settings.enabled")}</Label>
            <p className="text-[11px] text-muted-foreground">{t("settings.enabledDesc")}</p>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(enabled) => setSettings({ ...settings, enabled })}
            aria-label={t("settings.enabled")}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">{t("settings.windowDays")}</Label>
            <Input
              type="number"
              min={1}
              value={settings.windowDays}
              onChange={(e) =>
                setSettings({ ...settings, windowDays: Number(e.target.value) || 1 })
              }
              className="h-8 text-xs"
              aria-label={t("settings.windowDays")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">
              {t("settings.intervalDays")}
            </Label>
            <Input
              type="number"
              min={1}
              value={settings.intervalDays}
              onChange={(e) =>
                setSettings({ ...settings, intervalDays: Number(e.target.value) || 1 })
              }
              className="h-8 text-xs"
              aria-label={t("settings.intervalDays")}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 @md/pet-pane:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">
              {t("settings.scheduleModeLabel")}
            </Label>
            <Select
              value={scheduleMode}
              onValueChange={(v) =>
                setSettings({
                  ...settings,
                  schedule: { ...settings.schedule, mode: v as RadarScheduleMode },
                })
              }
            >
              <SelectTrigger className="h-8 text-xs" aria-label={t("settings.scheduleModeLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">{t("settings.scheduleMode.off")}</SelectItem>
                <SelectItem value="daily">{t("settings.scheduleMode.daily")}</SelectItem>
                <SelectItem value="weekly">{t("settings.scheduleMode.weekly")}</SelectItem>
                <SelectItem value="custom">{t("settings.scheduleMode.custom")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {scheduleMode === "custom" && (
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">
                {t("settings.scheduleCustomCronLabel")}
              </Label>
              <Input
                value={settings.schedule?.customCron ?? ""}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    schedule: { mode: "custom", ...settings.schedule, customCron: e.target.value },
                  })
                }
                placeholder="0 9 * * *"
                className="h-8 font-mono text-xs"
                aria-label={t("settings.scheduleCustomCronLabel")}
              />
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void onSaveSettings()}
            disabled={saving}
            aria-label={t("settings.scheduleSaveAria")}
            data-testid="radar-settings-save"
          >
            {saving ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> : t("settings.save")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function RadarReportView({
  report,
  t,
}: {
  report: RadarReport
  t: ReturnType<typeof useTranslations>
}) {
  const maxHeat = Math.max(1, ...report.heatmap.map((h) => h.count))
  return (
    <div className="space-y-3 text-sm">
      <p className="rounded border-l-2 border-primary bg-card px-3 py-2 font-medium italic">
        {report.verdict}
      </p>

      <Section title={t("section.atAGlance")}>
        <ul className="list-disc space-y-1 pl-4">
          {report.atAGlance.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      </Section>

      <Section title={t("section.infoDiet")}>
        <p className="text-muted-foreground">{report.infoDiet}</p>
      </Section>
      <Section title={t("section.subconscious")}>
        <p className="text-muted-foreground">{report.subconscious}</p>
      </Section>
      <Section title={t("section.blindSpots")}>
        <p className="text-muted-foreground">{report.blindSpots}</p>
      </Section>

      {report.actions.length > 0 && (
        <Section title={t("section.actions")}>
          <ul className="list-decimal space-y-1 pl-4">
            {report.actions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Section>
      )}

      {report.graveyard.length > 0 && (
        <Section title={t("section.graveyard")}>
          <ul className="space-y-1 text-muted-foreground">
            {report.graveyard.map((g, i) => (
              <li key={i}>
                <span className="font-mono text-xs">#{g.index}</span> — {g.reason}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {report.topicCloud.length > 0 && (
        <Section title={t("section.topics")}>
          <div className="flex flex-wrap gap-1.5">
            {report.topicCloud.map((tp, i) => (
              <span key={i} className="rounded bg-secondary px-2 py-0.5 text-xs">
                {tp.topic}
              </span>
            ))}
          </div>
        </Section>
      )}

      <Section title={t("section.heatmap")}>
        <div className="flex items-end gap-0.5" aria-hidden>
          {report.heatmap.map((h) => (
            <div
              key={h.day}
              title={`${h.day}: ${h.count}`}
              className="w-2 rounded-sm bg-primary/60"
              style={{ height: `${4 + (h.count / maxHeat) * 28}px` }}
            />
          ))}
        </div>
      </Section>

      <p className="text-[11px] text-muted-foreground">
        {t("panel.meta", { count: report.itemCount, days: report.windowDays })}
      </p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  )
}

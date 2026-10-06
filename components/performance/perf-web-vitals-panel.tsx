"use client"

import { useId, useSyncExternalStore } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { Trash2Icon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { WEB_VITAL_NAMES, webVitalsStore } from "@/lib/perf/web-vitals"

/** Document-level measurements are separate from the dashboard's rolling samples. */
export function PerfWebVitalsPanel() {
  const t = useTranslations("performance.webVitals")
  const id = useId()
  const snapshot = useSyncExternalStore(
    webVitalsStore.subscribe,
    webVitalsStore.getSnapshot,
    webVitalsStore.getServerSnapshot
  )
  const { settings, metrics, supported, error, persistenceError } = snapshot

  return (
    <section className="rounded-lg border bg-background" aria-labelledby={`${id}-title`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0 flex-1">
          <h3 id={`${id}-title`} className="text-base font-medium">
            {t("title")}
          </h3>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={Object.keys(metrics).length === 0}
          onClick={() => webVitalsStore.clear()}
        >
          <Trash2Icon aria-hidden />
          {t("clear")}
        </Button>
      </header>
      <div className="space-y-4 p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor={`${id}-enabled`}>{t("collection.label")}</Label>
              <p id={`${id}-collection-hint`} className="mt-1 text-xs text-muted-foreground">
                {t("collection.description")}
              </p>
            </div>
            <Switch
              id={`${id}-enabled`}
              aria-describedby={`${id}-collection-hint`}
              checked={settings.enabled}
              onCheckedChange={(enabled) => webVitalsStore.updateSettings({ enabled })}
            />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor={`${id}-reporting`}>{t("reporting.label")}</Label>
              <p id={`${id}-reporting-hint`} className="mt-1 text-xs text-muted-foreground">
                {t("reporting.description")}
              </p>
              <Link
                className="mt-1 inline-block text-xs underline underline-offset-4"
                href="/me/logs?logsPanel=telemetry"
              >
                {t("reporting.settings")}
              </Link>
            </div>
            <Switch
              id={`${id}-reporting`}
              aria-describedby={`${id}-reporting-hint`}
              disabled={!settings.enabled}
              checked={settings.reporting}
              onCheckedChange={(reporting) => webVitalsStore.updateSettings({ reporting })}
            />
          </div>
        </div>
        {persistenceError ? (
          <p role="alert" className="text-sm text-destructive">
            {t("persistenceError")}
          </p>
        ) : null}
        {settings.enabled && error ? (
          <p role="alert" className="text-sm text-destructive">
            {t("loadError")}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {WEB_VITAL_NAMES.map((name) => {
            const enabled = settings.enabled && settings.metrics[name]
            const metric = enabled ? metrics[name] : undefined
            const status = !enabled
              ? "disabled"
              : error
                ? "error"
                : supported !== null && !supported.includes(name)
                  ? "unsupported"
                  : "pending"
            return (
              <div
                key={name}
                role="group"
                aria-label={t(`metrics.${name}.label`)}
                className="min-w-0 rounded-md border p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">{t(`metrics.${name}.label`)}</span>
                  <Switch
                    aria-label={t("metricToggle", { metric: name })}
                    disabled={!settings.enabled}
                    checked={settings.metrics[name]}
                    onCheckedChange={(checked) =>
                      webVitalsStore.updateSettings({
                        metrics: { ...settings.metrics, [name]: checked },
                      })
                    }
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(`metrics.${name}.description`)}
                </p>
                <div className="mt-3 flex min-h-7 flex-wrap items-center gap-2">
                  {metric ? (
                    <>
                      <span className="font-mono text-lg tabular-nums">
                        {name === "CLS"
                          ? metric.value.toFixed(3)
                          : t("milliseconds", { value: Math.round(metric.value) })}
                      </span>
                      <Badge variant={metric.rating === "poor" ? "destructive" : "secondary"}>
                        {t(`ratings.${metric.rating}`)}
                      </Badge>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t(`status.${status}`)}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">{t("lifecycleHint")}</p>
      </div>
    </section>
  )
}

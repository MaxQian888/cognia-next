"use client"

import { useEffect, useId, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { getRendererDiagnostics } from "@/lib/perf/renderer-diagnostics"

const GROUPS = ["resources", "interactions", "frames", "navigation"] as const
const PHASES = [
  "dnsMs",
  "connectMs",
  "tlsMs",
  "requestMs",
  "responseMs",
  "domInteractiveMs",
  "domContentLoadedMs",
  "loadMs",
] as const

/** Collection preferences are independent of demand from the panel, capture, or HUD. */
export function PerfBrowserDiagnostics() {
  const t = useTranslations("performance.browserDiagnostics")
  const id = useId()
  const diagnostics = getRendererDiagnostics()
  const snapshot = useSyncExternalStore(
    diagnostics.subscribe,
    diagnostics.getSnapshot,
    diagnostics.getServerSnapshot
  )
  useEffect(() => diagnostics.connect(), [diagnostics])
  const { settings, supported, errors, persistenceError } = snapshot
  const navigationState =
    !settings.enabled || !settings.navigation
      ? "off"
      : errors.navigation
        ? "error"
        : !supported.navigation
          ? "unsupported"
          : "ready"
  const navigation = navigationState === "ready" ? snapshot.navigation : null

  return (
    <section className="rounded-lg border bg-background" aria-labelledby={`${id}-title`}>
      <header className="space-y-1 border-b p-4">
        <h3 id={`${id}-title`} className="text-base font-medium">
          {t("title")}
        </h3>
        <p className="max-w-prose text-xs text-muted-foreground">{t("description")}</p>
      </header>
      <div className="space-y-4 p-4">
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
            onCheckedChange={(enabled) => diagnostics.updateSettings({ enabled })}
          />
        </div>
        {persistenceError ? (
          <p role="alert" className="text-sm text-destructive">
            {t("persistenceError")}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {GROUPS.map((group) => {
            const status =
              !settings.enabled || !settings[group]
                ? "off"
                : errors[group]
                  ? "error"
                  : !supported[group]
                    ? "unsupported"
                    : "ready"
            return (
              <div
                key={group}
                role="group"
                aria-label={t(`groups.${group}.label`)}
                className="min-w-0 rounded-md border p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor={`${id}-${group}`}>{t(`groups.${group}.label`)}</Label>
                  <Switch
                    id={`${id}-${group}`}
                    checked={settings[group]}
                    disabled={!settings.enabled}
                    onCheckedChange={(checked) => diagnostics.updateSettings({ [group]: checked })}
                  />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(`groups.${group}.description`)}
                </p>
                <p className="mt-2 text-xs font-medium">{t(`status.${status}`)}</p>
              </div>
            )
          })}
        </div>
        <section aria-labelledby={`${id}-navigation-title`} className="rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h4 id={`${id}-navigation-title`} className="text-sm font-medium">
              {t("navigation.title")}
            </h4>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!navigation}
              onClick={() => diagnostics.clear()}
            >
              {t("navigation.clear")}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("navigation.description")}</p>
          {navigationState === "ready" ? (
            <dl className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {PHASES.map((phase) => {
                const value = navigation?.[phase]
                return (
                  <div key={phase} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      {t(`navigation.phases.${phase}`)}
                    </dt>
                    <dd className="mt-1 font-mono text-sm tabular-nums">
                      {value !== null && value !== undefined
                        ? t("milliseconds", { value: Math.round(value * 10) / 10 })
                        : t("navigation.pending")}
                    </dd>
                  </div>
                )
              })}
            </dl>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">{t(`status.${navigationState}`)}</p>
          )}
        </section>
        <p className="text-xs text-muted-foreground">{t("lifecycleHint")}</p>
      </div>
    </section>
  )
}

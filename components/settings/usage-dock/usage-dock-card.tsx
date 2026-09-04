"use client"

/**
 * Settings card for the Capacity Dock (ADR-0165 Phase 2).
 *
 * The card leads with what the platform can actually do. A Wayland compositor
 * that refuses client-side window positioning cannot host an edge rail, and a
 * card that hid its controls there would leave the user toggling a switch that
 * silently does nothing. Instead the controls render, disabled, above one line
 * saying why, with the tray named as the surface that still works.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Surface } from "@/components/surface/surface"
import {
  listUsageDockMonitors,
  setUsageDockMonitor,
  setUsageDockPlacement,
  setUsageDockScale,
  usageDockCapabilities,
} from "@/lib/usage-dock/client"
import { useUsageDockStore } from "@/lib/usage-dock/store"
import {
  clampDockScale,
  DOCK_EDGES,
  MAX_DOCK_SCALE,
  MIN_DOCK_SCALE,
  type DockEdge,
  type DockGaugeMode,
  type UsageDockCapabilities,
  type UsageDockMonitor,
} from "@/lib/usage-dock/types"

const GAUGE_MODES: readonly DockGaugeMode[] = ["budget", "quota"]

/** Monitor rows the picker offers, "primary" first. */
export function monitorOptions(monitors: readonly UsageDockMonitor[]): UsageDockMonitor[] {
  return [...monitors].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
}

export function UsageDockCard() {
  const t = useTranslations("settings.usageDock")
  const preferences = useUsageDockStore((s) => s.preferences)
  const setPreferences = useUsageDockStore((s) => s.setPreferences)
  const hydrate = useUsageDockStore((s) => s.hydrate)
  const reset = useUsageDockStore((s) => s.reset)

  const [capabilities, setCapabilities] = useState<UsageDockCapabilities | null>(null)
  const [monitors, setMonitors] = useState<UsageDockMonitor[]>([])

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    let alive = true
    void usageDockCapabilities().then((caps) => {
      if (alive) setCapabilities(caps)
    })
    void listUsageDockMonitors().then((list) => {
      if (alive) setMonitors(list)
    })
    return () => {
      alive = false
    }
  }, [])

  const supported = capabilities?.positioning ?? false
  const blocked = capabilities?.blockedReason ?? null

  const onEdge = useCallback(
    (edge: DockEdge) => {
      setPreferences({ edge })
      void setUsageDockPlacement(edge, preferences.offset)
    },
    [setPreferences, preferences.offset]
  )

  const onMonitor = useCallback(
    (value: string) => {
      const monitor = value === "primary" ? null : value
      setPreferences({ monitor })
      void setUsageDockMonitor(monitor)
    },
    [setPreferences]
  )

  const onScale = useCallback(
    (value: number) => {
      const scale = clampDockScale(value)
      setPreferences({ scale })
      void setUsageDockScale(scale)
    },
    [setPreferences]
  )

  return (
    <Surface layer="raised" className="space-y-4 rounded-md border p-4">
      <div>
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {blocked && (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" role="note">
          {t(`blocked.${blocked}`)}
        </p>
      )}

      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="usage-dock-enabled">{t("enabled")}</Label>
        <Switch
          id="usage-dock-enabled"
          checked={preferences.enabled}
          disabled={!supported}
          onCheckedChange={(on) => setPreferences({ enabled: on })}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <Label>{t("edge")}</Label>
        <Select
          value={preferences.edge}
          disabled={!supported}
          onValueChange={(v) => onEdge(v as DockEdge)}
        >
          <SelectTrigger className="w-44" aria-label={t("edge")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DOCK_EDGES.map((edge) => (
              <SelectItem key={edge} value={edge}>
                {t(`edges.${edge}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4">
        <Label>{t("monitor")}</Label>
        <Select
          value={preferences.monitor ?? "primary"}
          disabled={!supported || monitors.length === 0}
          onValueChange={onMonitor}
        >
          <SelectTrigger className="w-44" aria-label={t("monitor")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="primary">{t("monitorPrimary")}</SelectItem>
            {monitorOptions(monitors).map((m, index) => (
              <SelectItem key={m.name ?? `display-${index}`} value={m.name ?? `display-${index}`}>
                {m.name ?? t("monitorUnnamed", { index: index + 1 })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <Label>{t("gauge")}</Label>
          <p className="text-xs text-muted-foreground">{t("gaugeHint")}</p>
        </div>
        <Select
          value={preferences.gaugeMode}
          disabled={!supported}
          onValueChange={(v) => setPreferences({ gaugeMode: v as DockGaugeMode })}
        >
          <SelectTrigger className="w-44" aria-label={t("gauge")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GAUGE_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(`gauges.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="usage-dock-scale">{t("scale")}</Label>
        <Slider
          id="usage-dock-scale"
          className="w-44"
          aria-label={t("scale")}
          min={MIN_DOCK_SCALE}
          max={MAX_DOCK_SCALE}
          step={0.05}
          disabled={!supported}
          value={[preferences.scale]}
          onValueChange={([v]) => onScale(v)}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="usage-dock-fullscreen">{t("hideOnFullscreen")}</Label>
          <p className="text-xs text-muted-foreground">{t("hideOnFullscreenHint")}</p>
        </div>
        <Switch
          id="usage-dock-fullscreen"
          checked={preferences.hideOnFullscreen}
          disabled={!supported}
          onCheckedChange={(on) => setPreferences({ hideOnFullscreen: on })}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="usage-dock-expanded">{t("startExpanded")}</Label>
        <Switch
          id="usage-dock-expanded"
          checked={preferences.startExpanded}
          disabled={!supported}
          onCheckedChange={(on) => setPreferences({ startExpanded: on })}
        />
      </div>

      <Button type="button" variant="outline" size="sm" onClick={reset}>
        {t("reset")}
      </Button>
    </Surface>
  )
}

export default UsageDockCard

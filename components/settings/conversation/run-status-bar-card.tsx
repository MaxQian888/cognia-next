"use client"

import { useTranslations } from "next-intl"
import { GaugeIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import type { RunStatusBarSettings } from "@cognia/agent-config-types"
import { resolveRunStatusBarSettings } from "@/lib/chat/run-bar-metrics"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { SettingsCard } from "../common/settings-section"

/**
 * Settings → Conversation → "Run status bar": choose which metrics the chat
 * run-status bar (the strip pinned above the composer) surfaces on its
 * collapsed face — elapsed clock, output tokens, model speed, cost, context
 * fill, and the turn's tool count. Behavior prefs persist to
 * `AppSettings.runStatusBar`; read sites resolve defaults via
 * `resolveRunStatusBarSettings`, so an absent object keeps today's defaults.
 */
export function RunStatusBarCard() {
  const t = useTranslations("settings.conversation.runStatusBar")
  const settings = useSettingsStore((s) => s.settings?.runStatusBar)
  const save = useSettingsStore((s) => s.save)
  const resolved = resolveRunStatusBarSettings(settings)

  const saveBar = (patch: Partial<RunStatusBarSettings>) =>
    void save({ runStatusBar: { ...settings, ...patch } })

  const rows: Array<{
    id: string
    heading: string
    description: string
    label: string
    checked: boolean
    onCheckedChange: (v: boolean) => void
  }> = [
    {
      id: "run-bar-elapsed",
      heading: t("elapsed.heading"),
      description: t("elapsed.description"),
      label: t("elapsed.label"),
      checked: resolved.showElapsed,
      onCheckedChange: (v) => saveBar({ showElapsed: v }),
    },
    {
      id: "run-bar-tokens",
      heading: t("outputTokens.heading"),
      description: t("outputTokens.description"),
      label: t("outputTokens.label"),
      checked: resolved.showOutputTokens,
      onCheckedChange: (v) => saveBar({ showOutputTokens: v }),
    },
    {
      id: "run-bar-speed",
      heading: t("speed.heading"),
      description: t("speed.description"),
      label: t("speed.label"),
      checked: resolved.showSpeed,
      onCheckedChange: (v) => saveBar({ showSpeed: v }),
    },
    {
      id: "run-bar-cost",
      heading: t("cost.heading"),
      description: t("cost.description"),
      label: t("cost.label"),
      checked: resolved.showCost,
      onCheckedChange: (v) => saveBar({ showCost: v }),
    },
    {
      id: "run-bar-context",
      heading: t("contextPct.heading"),
      description: t("contextPct.description"),
      label: t("contextPct.label"),
      checked: resolved.showContextPct,
      onCheckedChange: (v) => saveBar({ showContextPct: v }),
    },
    {
      id: "run-bar-tools",
      heading: t("tools.heading"),
      description: t("tools.description"),
      label: t("tools.label"),
      checked: resolved.showTools,
      onCheckedChange: (v) => saveBar({ showTools: v }),
    },
  ]

  return (
    <SettingsCard
      icon={<GaugeIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <div className="space-y-6" data-testid="run-status-bar-card">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor={row.id}>{row.heading}</Label>
              <p className="text-sm text-muted-foreground">{row.description}</p>
            </div>
            <Switch
              id={row.id}
              aria-label={row.label}
              checked={row.checked}
              onCheckedChange={row.onCheckedChange}
            />
          </div>
        ))}
      </div>
    </SettingsCard>
  )
}

export default RunStatusBarCard

"use client"

// Stand-alone analytics panel — same data source as the AnalyticsTab in
// `plugin-panel.tsx` but presented per-plugin (when `pluginId` is set) or
// across all plugins. Mirrors `components/skills/skill-analytics.tsx`.
//
// Rendered flat in two places (the plugin detail pane's Data tab and the
// Governance pane), so it carries its own anonymous `@container` and answers
// to its own width rather than the viewport. Neither host gives it a nested
// scroller: the pane scrolls, and a long table is capped behind "Show all".

import { useState } from "react"
import { useFormatter, useLocale, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BarChart3Icon, ZapIcon, TimerIcon, AlertCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { listPlugins } from "@/lib/db/plugins"
import { PLUGIN_ANALYTIC_KEYS } from "@/lib/plugin/analytics/record"
import { cn } from "@/lib/utils"
import { usePluginAnalytics } from "@/hooks/plugins"
import { localizePluginText } from "@/hooks/plugins/use-localized-plugin-text"

interface Props {
  /** When set, narrow the analytics view to a single plugin. */
  pluginId?: string
}

/** Local date + time to the second, the precision the column always carried. */
const LAST_EVENT_FORMAT = { dateStyle: "medium", timeStyle: "medium" } as const

/** A usable instant, or null for a missing (0) or unparseable one. */
function toEventDate(at: number | undefined): Date | null {
  if (!at) return null
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Rows shown before "Show all" in the all-plugins view. */
export const ANALYTICS_ROW_LIMIT = 20

/**
 * Surface failures for one plugin. The recorder writes them under
 * `surface.error`; this used to read a bare `error` key that nothing writes,
 * so the Errors figure was always zero.
 */
function errorCount(byKey: Record<string, { count: number }>): number {
  return byKey[PLUGIN_ANALYTIC_KEYS.surfaceError]?.count ?? 0
}

export function PluginAnalytics({ pluginId }: Props) {
  const t = useTranslations("plugins.analyticsPanel")
  const format = useFormatter()
  const locale = useLocale()
  const analytics = usePluginAnalytics()
  const plugins = useLiveQuery(() => listPlugins(), [])
  const [showAll, setShowAll] = useState(false)

  if (analytics.loading || !plugins) {
    return <p className="text-xs text-muted-foreground">{t("loading")}</p>
  }

  const filtered = pluginId
    ? analytics.byPlugin.filter((p) => p.pluginId === pluginId)
    : analytics.byPlugin

  if (filtered.length === 0) {
    return (
      <p className="@container flex items-center gap-2 text-xs text-muted-foreground">
        <BarChart3Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {t("empty")}
      </p>
    )
  }

  const totalEvents = filtered.reduce((sum, p) => sum + p.totalEvents, 0)
  const totalKeys = filtered.reduce((sum, p) => sum + Object.keys(p.byKey).length, 0)
  const totalErrors = filtered.reduce((sum, p) => sum + errorCount(p.byKey), 0)
  const visible = showAll ? filtered : filtered.slice(0, ANALYTICS_ROW_LIMIT)

  return (
    <div className="@container space-y-3" data-testid="plugin-analytics">
      {/* Three facts, read left to right. A definition list, not three boxed
          tiles: the numbers carry the weight, the labels stay quiet. */}
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        <Stat icon={ZapIcon} label={t("summaryEvents")} value={format.number(totalEvents)} />
        <Stat icon={TimerIcon} label={t("summaryKeys")} value={format.number(totalKeys)} />
        <Stat
          icon={AlertCircleIcon}
          label={t("summaryErrors")}
          value={format.number(totalErrors)}
          tone={totalErrors > 0 ? "destructive" : undefined}
        />
      </dl>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("colPlugin")}</TableHead>
            <TableHead className="text-right">{t("colEvents")}</TableHead>
            <TableHead className="hidden text-right @sm:table-cell">{t("colKeys")}</TableHead>
            <TableHead className="hidden text-right @md:table-cell">{t("colLastEvent")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((entry) => {
            const plugin = plugins.find((p) => p.id === entry.pluginId)
            const lastEvent = toEventDate(entry.lastEventAt)
            return (
              <TableRow key={entry.pluginId}>
                <TableCell>
                  <div className="min-w-0 space-y-0.5">
                    <div className="truncate text-sm font-medium">
                      {plugin ? localizePluginText(plugin, locale).name : entry.pluginId}
                    </div>
                    <div className="max-w-[14ch] truncate font-mono text-xs text-muted-foreground @sm:max-w-none">
                      {entry.pluginId}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {format.number(entry.totalEvents)}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums @sm:table-cell">
                  {format.number(Object.keys(entry.byKey).length)}
                </TableCell>
                <TableCell className="hidden text-right text-xs text-muted-foreground @md:table-cell">
                  {lastEvent ? (
                    <time dateTime={lastEvent.toISOString()}>
                      {format.dateTime(lastEvent, LAST_EVENT_FORMAT)}
                    </time>
                  ) : (
                    t("noLastEvent")
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      {filtered.length > ANALYTICS_ROW_LIMIT && (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 h-7 text-xs text-muted-foreground pointer-coarse:h-10"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
        >
          {showAll ? t("showLess") : t("showAll", { count: filtered.length })}
        </Button>
      )}
    </div>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  tone?: "destructive"
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
        {label}
      </dt>
      <dd
        className={cn(
          "text-xl font-semibold tabular-nums",
          tone === "destructive" && "text-destructive"
        )}
      >
        {value}
      </dd>
    </div>
  )
}

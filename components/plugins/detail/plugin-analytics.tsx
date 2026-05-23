"use client"

// Stand-alone analytics panel — same data source as the AnalyticsTab in
// `plugin-panel.tsx` but presented per-plugin (when `pluginId` is set) or
// across all plugins. Mirrors `components/skills/skill-analytics.tsx`.

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BarChart3Icon, ZapIcon, TimerIcon, AlertCircleIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { listPlugins } from "@/lib/db/plugins"
import { usePluginAnalytics } from "@/hooks/plugins"

interface Props {
  /** When set, narrow the analytics view to a single plugin. */
  pluginId?: string
}

export function PluginAnalytics({ pluginId }: Props) {
  const t = useTranslations("plugins.analyticsPanel")
  const analytics = usePluginAnalytics()
  const plugins = useLiveQuery(() => listPlugins(), [])

  if (analytics.loading || !plugins) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }

  const filtered = pluginId
    ? analytics.byPlugin.filter((p) => p.pluginId === pluginId)
    : analytics.byPlugin

  if (filtered.length === 0) {
    return (
      <Card className="p-6 text-center space-y-2">
        <BarChart3Icon className="size-10 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </Card>
    )
  }

  const totalEvents = filtered.reduce((sum, p) => sum + p.totalEvents, 0)
  const totalKeys = filtered.reduce((sum, p) => sum + Object.keys(p.byKey).length, 0)
  const totalErrors = filtered.reduce((sum, p) => sum + (p.byKey["error"]?.count ?? 0), 0)

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard
          icon={ZapIcon}
          label={t("summaryEvents")}
          value={totalEvents.toLocaleString()}
        />
        <SummaryCard icon={TimerIcon} label={t("summaryKeys")} value={totalKeys.toString()} />
        <SummaryCard
          icon={AlertCircleIcon}
          label={t("summaryErrors")}
          value={totalErrors.toString()}
          variant={totalErrors > 0 ? "destructive" : undefined}
        />
      </div>

      <Card className="p-0 flex flex-col max-h-[60vh] md:max-h-[70vh]">
        <ScrollArea className="flex-1 min-h-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colPlugin")}</TableHead>
                  <TableHead className="text-right">{t("colEvents")}</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">{t("colKeys")}</TableHead>
                  <TableHead className="hidden md:table-cell text-right">
                    {t("colLastEvent")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((entry) => {
                  const plugin = plugins.find((p) => p.id === entry.pluginId)
                  return (
                    <TableRow key={entry.pluginId}>
                      <TableCell>
                        <div className="space-y-0.5 min-w-0">
                          <div className="font-medium text-sm truncate">
                            {plugin?.name ?? entry.pluginId}
                          </div>
                          <div className="font-mono text-xs text-muted-foreground truncate max-w-[14ch] sm:max-w-none">
                            {entry.pluginId}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {entry.totalEvents.toLocaleString()}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-right">
                        {Object.keys(entry.byKey).length}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-right text-xs text-muted-foreground">
                        {new Date(entry.lastEventAt).toISOString().slice(0, 19).replace("T", " ")}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </ScrollArea>
      </Card>
    </div>
  )
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  variant,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  variant?: "destructive"
}) {
  return (
    <Card className="p-3 space-y-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="text-xl md:text-2xl font-semibold tabular-nums flex flex-wrap items-center gap-2">
        {value}
        {variant === "destructive" && Number(value) > 0 && (
          <Badge variant="destructive" className="text-xs">
            !
          </Badge>
        )}
      </div>
    </Card>
  )
}

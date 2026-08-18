"use client"

/**
 * Dashboard toolbar: variable filter bar, time-range picker, auto-refresh
 * cadence + manual refresh, export/import menu, settings, and the edit/lock +
 * reset-layout controls.
 */

import { useTranslations } from "next-intl"
import { LockIcon, PencilIcon, RotateCcwIcon, Settings2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { TimeRangePicker } from "./time-range-picker"
import { RefreshSelect } from "./refresh-select"
import { RefreshStatus } from "./refresh-status"
import { ExportMenu } from "./export-menu"
import { VariableFilterBar } from "./variable-filter-bar"
import { DroppedSpansBadge } from "./dropped-spans-badge"
import type { RangePreset } from "@/lib/observability/time-range"
import type { TraceFilters } from "@/lib/observability/filters"
import type { RefreshMs } from "@/stores/observability/observability-store"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { TraceRollupRow } from "@/lib/observability/trace-rollup"
import type { DashboardConfig } from "@/lib/observability/dashboard-config"

export interface ObservabilityToolbarProps {
  preset: RangePreset | "custom"
  customSince: number | null
  customUntil: number | null
  refreshMs: RefreshMs
  filters: TraceFilters
  editMode: boolean
  windowSpans: AgentTraceSpan[]
  lastUpdated: number | null
  traces: TraceRollupRow[]
  onPreset: (p: RangePreset) => void
  onCustom: (since: number, until: number) => void
  onRefreshMs: (ms: RefreshMs) => void
  onRefresh: () => void
  onFilters: (f: TraceFilters) => void
  onToggleEdit: () => void
  onResetLayout: () => void
  onOpenSettings: () => void
  buildConfig: () => DashboardConfig
  onImportConfig: (cfg: DashboardConfig) => void
}

export function ObservabilityToolbar(props: ObservabilityToolbarProps) {
  const t = useTranslations("observability.toolbar")
  return (
    <div
      className="flex w-full min-w-0 flex-wrap items-center gap-2"
      data-testid="observability-toolbar"
    >
      <VariableFilterBar
        windowSpans={props.windowSpans}
        filters={props.filters}
        onChange={props.onFilters}
      />
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2 lg:ml-auto lg:w-auto">
        <DroppedSpansBadge refreshKey={props.lastUpdated} />
        <RefreshStatus lastUpdated={props.lastUpdated} onRefresh={props.onRefresh} />
        <TimeRangePicker
          preset={props.preset}
          customSince={props.customSince}
          customUntil={props.customUntil}
          onPreset={props.onPreset}
          onCustom={props.onCustom}
        />
        <RefreshSelect value={props.refreshMs} onChange={props.onRefreshMs} />
        <Separator orientation="vertical" className="h-6" />
        <ExportMenu
          traces={props.traces}
          buildConfig={props.buildConfig}
          onImportConfig={props.onImportConfig}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={props.onOpenSettings}
          className="gap-1.5"
          data-testid="open-settings"
          aria-label={t("settings")}
        >
          <Settings2Icon className="size-3.5" />
        </Button>
        <Button
          variant={props.editMode ? "default" : "outline"}
          size="sm"
          onClick={props.onToggleEdit}
          className="gap-1.5"
          data-testid="toggle-edit"
          aria-pressed={props.editMode}
        >
          {props.editMode ? <LockIcon className="size-3.5" /> : <PencilIcon className="size-3.5" />}
          {props.editMode ? t("lock") : t("edit")}
        </Button>
        {props.editMode && (
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onResetLayout}
            className="gap-1.5"
            data-testid="reset-layout"
          >
            <RotateCcwIcon className="size-3.5" />
            {t("resetLayout")}
          </Button>
        )}
      </div>
    </div>
  )
}
